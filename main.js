import { Client, Databases, ID, Query } from 'node-appwrite';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { Document, Paragraph, Packer, TextRun } from 'docx';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import FormData from 'form-data';

// Set FFmpeg path and verify
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
} else {
  console.error('FFmpeg binary not found in ffmpeg-static');
}

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);
const db = new Databases(client);

// Fallback for VAKIL_JIBI_BOT
const VAKIL_JIBI_BOT = process.env.VAKIL_JIBI_BOT || '@vakil_jibi_bot';
const VAKIL_JIBI_BOT_URL = VAKIL_JIBI_BOT.replace(/^@/, '');

// Initialize Gemini client for text-based tasks
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

export default async ({ req, res, log, error }) => {
  let chatId = null;
  let text = '';
  let body = {};
  let isVoice = false;
  let isNoteMaking = false;
  let updateId = null;

  // Parse request body
  try {
    if (typeof req.body === 'string') {
      body = JSON.parse(req.body);
      log(`Parsed request body: ${JSON.stringify(body).slice(0, 100)}...`);
    } else if (typeof req.body === 'object' && req.body !== null) {
      body = req.body;
      log('Request body is object');
    } else {
      throw new Error('Request body is invalid');
    }
    updateId = body.update_id ? String(body.update_id) : null;
  } catch (e) {
    error(`Failed to parse request body: ${e.message}`);
    return res.json({ status: 'error', message: e.message }, 200);
  }

  // Handle callback queries and messages
  if (body.callback_query) {
    chatId = body.callback_query.message.chat.id.toString();
    text = body.callback_query.data || '';
    log(`Processing callback query: ${text} from chat ${chatId}`);
  } else if (body.message) {
    chatId = body.message.chat.id.toString();
    if (body.message.text) {
      text = body.message.text.trim();
      log(
        `Processing text message: ${text} from chat ${chatId}, update_id: ${updateId || 'unknown'}`
      );
    } else if (body.message.voice) {
      isVoice = true;
      text = 'صدا';
      log(
        `Processing voice message from chat ${chatId}, update_id: ${updateId || 'unknown'}`
      );
    } else {
      text = getMessageType(body.message);
      log(`Processing non-text/voice message: ${text} from chat ${chatId}`);
      const sess = await getActive(chatId);
      if (sess) {
        await saveChat(sess.$id, chatId, 'user', text, updateId);
        try {
          await tg(
            chatId,
            '🚫 فقط پیام‌های متنی و صوتی پشتیبانی می‌شوند.',
            { inline_keyboard: menu() },
            updateId
          );
        } catch (e) {
          error(`tg error in non-text/voice message: ${e.message}`);
        }
      } else {
        error(`No active session for chat ${chatId}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
  } else {
    log(
      `No message or callback in update, update_id: ${updateId || 'unknown'}`
    );
    return res.json({ status: 'ok' }, 200);
  }

  const userState = await getUserState(chatId);
  isNoteMaking =
    userState && userState.mode === 'note_making' && userState.activeNoteId;
  log(
    `User state: isNoteMaking=${isNoteMaking}, activeNoteId=${userState ? userState.activeNoteId : 'none'}`
  );

  // Process voice messages
  if (isVoice) {
    try {
      const fileId = body.message.voice.file_id;
      const audioUrl = await getTelegramFileUrl(fileId);
      const tempDir = tmpdir();
      const oggPath = join(tempDir, `voice_${fileId}.ogg`);
      const wavPath = join(tempDir, `voice_${fileId}.wav`);

      // Download audio
      const response = await fetch(audioUrl);
      if (!response.ok)
        throw new Error(`Failed to fetch audio: ${response.statusText}`);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      writeFileSync(oggPath, buffer);
      log(`Audio downloaded to ${oggPath}`);

      // Verify FFmpeg availability before conversion
      if (!ffmpegStatic || !existsSync(ffmpegStatic)) {
        throw new Error(
          'FFmpeg is not available. Please ensure FFmpeg is installed in the runtime environment.'
        );
      }

      // Convert OGG to WAV
      await convertToWav(oggPath, wavPath);
      log(`Converted to ${wavPath}`);

      // Read WAV buffer
      const wavBuffer = readFileSync(wavPath);
      log(`WAV file size: ${wavBuffer.length} bytes`);

      // Transcribe audio
      text = await transcribeAudio(wavBuffer, 'audio/wav', fileId);
      if (!text) {
        try {
          await tg(
            chatId,
            '🚫 پیام صوتی خالی یا غیرقابل پردازش است. لطفاً یک پیام صوتی واضح ارسال کنید.',
            { inline_keyboard: isNoteMaking ? noteMenu() : menu() },
            updateId
          );
        } catch (e) {
          error(`tg error in voice transcription: ${e.message}`);
        }
        return res.json({ status: 'ok' }, 200);
      }
      log(`Transcription: "${text}"`);

      // Save voice transcription to database
      const sess = await getActive(chatId);
      await saveChat(sess.$id, chatId, 'user', text, updateId);

      // Clean up
      if (existsSync(oggPath)) unlinkSync(oggPath);
      if (existsSync(wavPath)) unlinkSync(wavPath);
      log(`Cleaned up files: ${oggPath}, ${wavPath}`);
    } catch (e) {
      error(`Voice processing error: ${e.message}`);
      try {
        await tg(
          chatId,
          `🚫 خطا در پردازش پیام صوتی: ${e.message}`,
          { inline_keyboard: isNoteMaking ? noteMenu() : menu() },
          updateId
        );
      } catch (e) {
        error(`tg error in voice processing: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
  }

  // Main logic
  try {
    const user = await upsertUser(chatId);
    if (!user) {
      try {
        await tg(
          chatId,
          '🚫 خطا در ثبت کاربر. لطفاً دوباره تلاش کنید.',
          { inline_keyboard: menu() },
          updateId
        );
      } catch (e) {
        error(`tg error in upsertUser: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
    if (user.usageCount >= 400) {
      try {
        await tg(
          chatId,
          `⛔ سقف مصرف ماهانه شما پر شده است. لطفاً ماه آینده دوباره تلاش کنید یا برای مشاوره حقوقی رایگان دکمه زیر را فشار دهید.`,
          { inline_keyboard: menu() },
          updateId
        );
      } catch (e) {
        error(`tg error in usage limit: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }

    if (isNoteMaking && isVoice) {
      const noteText = text;
      const saveResult = await saveNoteChunk(userState.activeNoteId, noteText);
      if (!saveResult) {
        try {
          await tg(
            chatId,
            '🚫 خطا در ذخیره یادداشت. لطفاً دوباره تلاش کنید.',
            { inline_keyboard: noteMenu() },
            updateId
          );
        } catch (e) {
          error(`tg error in saveNoteChunk: ${e.message}`);
        }
        return res.json({ status: 'ok' }, 200);
      }
      const fullNote = await getFullNoteText(userState.activeNoteId);
      try {
        await tg(
          chatId,
          `یادداشت شما: "${fullNote}"\nمی‌توانید ادامه دهید، متن را کپی کنید یا به فایل ورد تبدیل کنید.`,
          { inline_keyboard: noteMenu() },
          updateId
        );
      } catch (e) {
        error(`tg error in note making: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }

    // Handle commands
    if (/^\/start/i.test(text) || text === 'back_to_menu') {
      await finishNote(chatId);
      try {
        await tg(
          chatId,
          `👋 به ربات چت هوشمند خوش آمدید!  
من می‌توانم:  
- **پاسخ به سوالات شما** با پیام‌های متنی یا صوتی (به فارسی).  
- **تولید تصاویر** بر اساس درخواست‌های شما (مثلاً "تصویر یک گربه بکش").  
- **تبدیل پیام‌های صوتی** به متن و ذخیره آن‌ها به‌عنوان یادداشت.  
- **ایجاد فایل ورد** از یادداشت‌های شما.  
- **خلاصه‌سازی گفتگوها** (۱۰۰ پیام اخیر یا کل تاریخچه).  
- دسترسی به **مشاوره حقوقی رایگان** از طریق دکمه زیر.  

**دکمه‌ها چه می‌کنند؟**  
- ✨ چت جدید: بازگشت به یک مکالمه جدید.  
- 📝 ساخت یادداشت جدید: شروع ضبط پیام‌های صوتی برای یادداشت.  
- 🔴 کانال یوتیوب: لینک به کانال یوتیوب ما.  
- 📜 خلاصه ۱۰۰ پیام: خلاصه ۱۰۰ پیام اخیر.  
- 📚 خلاصه همه پیام‌ها: خلاصه کل تاریخچه گفتگو.  
- ℹ️ راهنما: نمایش این راهنما.  
- 📝 دریافت مشاوره حقوقی رایگان: برای مشاوره حقوقی رایگان دکمه زیر را فشار دهید.  

پیام متنی یا صوتی بفرستید تا شروع کنیم!`,
          { inline_keyboard: menu() },
          updateId
        );
      } catch (e) {
        error(`tg error in /start: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
    if (/^\/help/i.test(text)) {
      try {
        await tg(
          chatId,
          `ℹ️ **راهنمای ربات چت هوشمند**  
این ربات قابلیت‌های زیر را ارائه می‌دهد:  
- **پاسخ به سوالات**: با پیام متنی یا صوتی به سوالات شما به فارسی پاسخ می‌دهد.  
- **تولید تصویر**: با درخواست‌هایی مثل "تصویر یک منظره بکش"، تصاویر تولید می‌کند. اگر قبلاً تصویری تولید شده، می‌توانید درخواست ویرایش کنید (مثلاً "رنگ آسمان را آبی‌تر کن").  
- **یادداشت‌سازی**: پیام‌های صوتی را به متن تبدیل کرده و به‌عنوان یادداشت ذخیره می‌کند. می‌توانید یادداشت‌ها را کپی یا به فایل ورد تبدیل کنید.  
- **خلاصه‌سازی**: تاریخچه گفتگوها را خلاصه می‌کند (۱۰۰ پیام یا کل تاریخچه).  
- **مشاوره حقوقی رایگان**: از طریق دکمه زیر به ربات وکیل جیبی متصل شوید که رایگان و متن‌باز است.  

**دستورات و دکمه‌ها**:  
- /start یا "بازگشت به منوی اصلی": بازگشت به منوی اصلی.  
- /newchat یا "چت جدید": شروع مکالمه جدید.  
- /summary100 یا "خلاصه ۱۰۰ پیام": خلاصه ۱۰۰ پیام اخیر.  
- /summaryall یا "خلاصه همه پیام‌ها": خلاصه کل تاریخچه.  
- /makenote یا "ساخت یادداشت جدید": شروع یادداشت‌سازی با پیام صوتی.  
- /youtube یا "کانال یوتیوب": لینک به کانال یوتیوب.  
- "دریافت مشاوره حقوقی رایگان": برای مشاوره حقوقی رایگان دکمه زیر را فشار دهید.  

برای شروع، پیام متنی یا صوتی ارسال کنید!`,
          { inline_keyboard: menu() },
          updateId
        );
      } catch (e) {
        error(`tg error in /help: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
    if (/^\/youtube/i.test(text)) {
      try {
        await tg(
          chatId,
          '🌟 از ربات چت هوشمند لذت می‌برید؟ لطفاً کانال یوتیوب ما را دنبال کنید و سابسکرایب کنید تا از محتوای آموزشی و جذاب ما بهره‌مند شوید! 👇\nhttps://www.youtube.com/@pishnahadebehtar',
          { inline_keyboard: menu() },
          updateId
        );
      } catch (e) {
        error(`tg error in /youtube: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
    if (/^\/newchat/i.test(text)) {
      await finishSessions(chatId);
      await finishNote(chatId);
      await createSession(chatId, '');
      try {
        await tg(
          chatId,
          '✨ یک مکالمه جدید آغاز شد!  \nمی‌توانید پیام متنی یا صوتی ارسال کنید تا به سوالات شما پاسخ دهم، تصویر تولید کنم یا یادداشت بسازید. برای مشاوره حقوقی رایگان، دکمه زیر را فشار دهید.',
          { inline_keyboard: menu() },
          updateId
        );
      } catch (e) {
        error(`tg error in /newchat: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
    if (/^\/summary(all|100)/i.test(text)) {
      const lim = text.includes('100') ? 100 : 1000;
      const chats = await chatsUser(chatId, lim);
      const sum = await summarize(chats);
      const sess = await getActive(chatId);
      await db.updateDocument(
        process.env.DB_ID,
        process.env.SESSIONS_COLLECTION,
        sess.$id,
        { context: sum }
      );
      try {
        await tg(
          chatId,
          `📝 خلاصه ${lim === 100 ? '۱۰۰ پیام اخیر' : 'کل تاریخچه'} ایجاد شد:\n${sum}\nبرای ادامه، پیام متنی یا صوتی بفرستید یا از دکمه‌ها استفاده کنید.`,
          { inline_keyboard: menu() },
          updateId
        );
      } catch (e) {
        error(`tg error in /summary: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
    if (/^\/makenote/i.test(text) || text === 'make_new_note') {
      await finishNote(chatId);
      const note = await createNote(chatId);
      if (!note) {
        try {
          await tg(
            chatId,
            '🚫 خطا در ایجاد یادداشت جدید. لطفاً دوباره تلاش کنید.',
            { inline_keyboard: menu() },
            updateId
          );
        } catch (e) {
          error(`tg error in /makenote: ${e.message}`);
        }
        return res.json({ status: 'ok' }, 200);
      }
      await setUserState(chatId, 'note_making', note.$id);
      try {
        await tg(
          chatId,
          '📝 یادداشت جدید ایجاد شد! لطفاً پیام صوتی ارسال کنید تا به متن تبدیل شود. سپس می‌توانید:  \n- ادامه دهید (ادامه یادداشت).  \n- متن را کپی کنید (کپی متن).  \n- آن را به فایل ورد تبدیل کنید (وارد کردن به ورد).  \n- یا به منوی اصلی بازگردید.',
          { inline_keyboard: noteMenu() },
          updateId
        );
      } catch (e) {
        error(`tg error in /makenote: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
    if (text === 'resume_note') {
      if (!isNoteMaking) {
        try {
          await tg(
            chatId,
            '🚫 هیچ یادداشت فعالی وجود ندارد. لطفاً با "ساخت یادداشت جدید" شروع کنید.',
            { inline_keyboard: menu() },
            updateId
          );
        } catch (e) {
          error(`tg error in resume_note: ${e.message}`);
        }
        return res.json({ status: 'ok' }, 200);
      }
      try {
        await tg(
          chatId,
          '📝 لطفاً پیام صوتی جدید خود را برای افزودن به یادداشت ارسال کنید.',
          { inline_keyboard: noteMenu() },
          updateId
        );
      } catch (e) {
        error(`tg error in resume_note: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
    if (text === 'copy_note') {
      if (!isNoteMaking) {
        try {
          await tg(
            chatId,
            '🚫 هیچ یادداشت فعالی وجود ندارد. لطفاً با "ساخت یادداشت جدید" شروع کنید.',
            { inline_keyboard: menu() },
            updateId
          );
        } catch (e) {
          error(`tg error in copy_note: ${e.message}`);
        }
        return res.json({ status: 'ok' }, 200);
      }
      const fullNote = await getFullNoteText(userState.activeNoteId);
      try {
        await tg(
          chatId,
          `📋 متن یادداشت شما: "${fullNote}"\nلطفاً متن را کپی کنید یا از دکمه‌های زیر برای ادامه استفاده کنید.`,
          { inline_keyboard: noteMenu() },
          updateId
        );
      } catch (e) {
        error(`tg error in copy_note: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }
    if (text === 'export_to_word') {
      if (!isNoteMaking) {
        try {
          await tg(
            chatId,
            '🚫 هیچ یادداشت فعالی وجود ندارد. لطفاً با "ساخت یادداشت جدید" شروع کنید.',
            { inline_keyboard: menu() },
            updateId
          );
        } catch (e) {
          error(`tg error in export_to_word: ${e.message}`);
        }
        return res.json({ status: 'ok' }, 200);
      }
      const fullNote = await getFullNoteText(userState.activeNoteId);
      if (!fullNote) {
        try {
          await tg(
            chatId,
            '🚫 یادداشت خالی است. لطفاً ابتدا پیام صوتی ارسال کنید.',
            { inline_keyboard: noteMenu() },
            updateId
          );
        } catch (e) {
          error(`tg error in export_to_word: ${e.message}`);
        }
        return res.json({ status: 'ok' }, 200);
      }
      const docPath = await createWordDocument(fullNote, chatId);
      try {
        await sendDocument(
          chatId,
          docPath,
          '📝 یادداشت شما در فایل ورد آماده شد!',
          updateId
        );
        if (existsSync(docPath)) unlinkSync(docPath);
        await tg(
          chatId,
          '✅ فایل ورد با موفقیت ارسال شد! می‌توانید ادامه دهید یا به منوی اصلی بازگردید.',
          { inline_keyboard: noteMenu() },
          updateId
        );
      } catch (e) {
        error(`tg error in export_to_word: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }

    // Process regular chat
    const sess = await getActive(chatId);
    if (!isVoice) await saveChat(sess.$id, chatId, 'user', text, updateId);
    const history = await chatsSession(sess.$id, 10);
    let conversation = history
      .map((c) => `${c.role === 'user' ? 'کاربر' : 'دستیار'}: ${c.content}`)
      .join('\n');
    conversation += `\nکاربر: ${text}`;

    const reasoningPrompt = `**اطلاعات ربات:**
این ربات می‌تواند:
- به سوالات کاربران به زبان فارسی پاسخ دهد (پیام متنی یا صوتی).
- پیام‌های صوتی را به متن پارسی دقیق رونویسی کند.
- تصاویر را بر اساس درخواست‌های کاربر تولید کند (مثلاً "تصویر یک گربه بکش").
- اگر کاربر قبلاً تصویری دریافت کرده (در سابقه گفتگو به تولید تصویر اشاره شده)، بررسی کنید آیا پیام فعلی درخواست ویرایش همان تصویر است (مثلاً تغییر رنگ، افزودن عنصر). در این صورت، پرامپت قبلی را اصلاح کرده و یک پرامپت جدید و دقیق به انگلیسی ایجاد کنید.
- یادداشت‌هایی از پیام‌های صوتی ایجاد کرده و آن‌ها را به فایل ورد تبدیل کند.
- گفتگوها را خلاصه‌سازی کند (۱۰۰ پیام یا کل تاریخچه).
- کاربران را برای مشاوره حقوقی رایگان به دکمه مربوطه هدایت کند.

**دستورات و دکمه‌ها:**
- /start یا "بازگشت به منوی اصلی": بازگشت به منوی اصلی.
- /newchat یا "چت جدید": شروع مکالمه جدید.
- /summary100 یا "خلاصه ۱۰۰ پیام": خلاصه ۱۰۰ پیام اخیر.
- /summaryall یا "خلاصه همه پیام‌ها": خلاصه کل تاریخچه.
- /makenote یا "ساخت یادداشت جدید": شروع یادداشت‌سازی با پیام صوتی.
- /youtube یا "کانال یوتیوب": لینک به کانال یوتیوب.
- "دریافت مشاوره حقوقی رایگان": برای مشاوره حقوقی رایگان دکمه زیر را فشار دهید.

**سابقه گفتگو:**
${conversation}

**وظیفه:**
1. بررسی کنید آیا پیام کاربر به تولید تصویر مربوط است یا خیر. پیام‌هایی که شامل کلمات کلیدی مانند "عکس"، "تصویر"، "بکش"، "نقاشی"، "طبیعت"، "منظره" یا عباراتی مانند "برای من بساز" در زمینه تصویر هستند، باید به‌عنوان درخواست تولید تصویر شناسایی شوند.
2. اگر کاربر قبلاً تصویری دریافت کرده (در سابقه گفتگو به تولید تصویر اشاره شده)، بررسی کنید آیا پیام فعلی درخواست ویرایش همان تصویر است (مثلاً تغییر رنگ، افزودن عنصر). در این صورت، پرامپت قبلی را اصلاح کرده و یک پرامپت جدید و دقیق به انگلیسی ایجاد کنید.
3. اگر پیام به تولید تصویر یا ویرایش تصویر مربوط است، یک پرامپت دقیق به انگلیسی تولید کنید (مثلاً "A beautiful forest landscape with a clear blue sky in a realistic style").
4. اگر پیام به تولید تصویر یا ویرایش تصویر مربوط نیست، یک پاسخ متنی به فارسی (حداکثر ۱۵۰۰ کاراکتر) تولید کنید. اگر کاربر درباره ربات یا مشاوره حقوقی سوال کرد، توضیح دهید که برای مشاوره حقوقی رایگان می‌تواند دکمه مربوطه را فشار دهد.
5. پاسخ را به‌صورت JSON خالص (بدون نشانه‌های Markdown مانند \`\`\`json یا \`\`\`) برگردانید:
   - اگر تصویر یا ویرایش تصویر لازم است: {"needs_image": true, "prompt": "پرامپت دقیق به انگلیسی برای مدل تولید تصویر"}
   - اگر پاسخ متنی لازم است: {"needs_image": false, "response": "پاسخ به فارسی، حداکثر ۱۵۰۰ کاراکتر"}`;

    let reasoningResponse;
    try {
      reasoningResponse = await getGenerativeModel(
        reasoningPrompt,
        'Reasoning',
        'gemini-2.0-flash',
        0
      );
      log(
        `Full reasoning response: ${JSON.stringify(reasoningResponse, null, 2)}`
      );
      let cleanedResponse = reasoningResponse.text.trim();
      cleanedResponse = cleanedResponse
        .replace(/^```json\n/, '')
        .replace(/\n```$/, '');
      reasoningResponse = cleanedResponse;
    } catch (e) {
      error(`Reasoning error: ${e.message}`);
      const fallbackPrompt = `سابقه:\n${sess.context || 'ندارد'}\n\n${conversation}\nپاسخ به فارسی (حداکثر ۱۵۰۰ کاراکتر). اگر کاربر درباره ربات یا مشاوره حقوقی سوال کرد، توضیح دهید که این ربات می‌تواند پاسخ دهد، تصویر تولید کند، یادداشت بسازد و کاربران را برای مشاوره حقوقی رایگان به دکمه مربوطه هدایت کند.`;
      const aiResponse = await askAI(fallbackPrompt);
      await saveChat(sess.$id, chatId, 'assistant', aiResponse, updateId);
      await db.updateDocument(
        process.env.DB_ID,
        process.env.USERS_COLLECTION,
        user.$id,
        {
          usageCount: user.usageCount + 1,
        }
      );
      let finalResponse = isVoice
        ? `این متن صدای شماست: "${text}"\n\nو این پاسخ من است: "${aiResponse}"`
        : aiResponse;
      try {
        await tg(chatId, finalResponse, { inline_keyboard: menu() }, updateId);
      } catch (e) {
        error(`tg error in reasoning fallback: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }

    let json;
    try {
      json = JSON.parse(reasoningResponse);
      log(`Parsed reasoning JSON: ${JSON.stringify(json, null, 2)}`);
    } catch (e) {
      error(`JSON parse error: ${e.message}, response: ${reasoningResponse}`);
      try {
        await tg(
          chatId,
          '🚨 خطا در پردازش درخواست. لطفاً دوباره تلاش کنید.',
          { inline_keyboard: menu() },
          updateId
        );
      } catch (e) {
        error(`tg error in JSON parse: ${e.message}`);
      }
      return res.json({ status: 'ok' }, 200);
    }

    await db.updateDocument(
      process.env.DB_ID,
      process.env.USERS_COLLECTION,
      user.$id,
      {
        usageCount: user.usageCount + 1,
      }
    );

    if (!json.needs_image) {
      const aiResponse = json.response;
      await saveChat(sess.$id, chatId, 'assistant', aiResponse, updateId);
      let finalResponse = isVoice
        ? `این متن صدای شماست: "${text}"\n\nو این پاسخ من است: "${aiResponse}"`
        : aiResponse;
      try {
        await tg(chatId, finalResponse, { inline_keyboard: menu() }, updateId);
      } catch (e) {
        error(`tg error in text response: ${e.message}`);
      }
    } else {
      const polishedPrompt = json.prompt; // Use the prompt directly from reasoning
      const finalImagePrompt = polishedPrompt; // Simplified to match sample code
      try {
        log(
          `Attempting image generation with Cloudflare endpoint prompt: ${finalImagePrompt}`
        );
        log(`Image Generator URL: ${process.env.IMAGE_GENERATOR_URL}`);
        log(`Image Generator API Key: ${process.env.IMAGE_GENERATOR_API_KEY}`);

        const imageGeneratorUrl = process.env.IMAGE_GENERATOR_URL;
        const imageGeneratorApiKey = process.env.IMAGE_GENERATOR_API_KEY;

        if (!imageGeneratorUrl || !imageGeneratorApiKey) {
          throw new Error('Image generator URL or API key is not defined');
        }

        const response = await axios.post(
          imageGeneratorUrl,
          { prompt: finalImagePrompt },
          {
            headers: {
              Authorization: `Bearer ${imageGeneratorApiKey}`,
              'Content-Type': 'application/json',
            },
            responseType: 'arraybuffer',
          }
        );

        log(`Response status: ${response.status}`);
        log(`Response headers: ${JSON.stringify(response.headers)}`);
        log(`Response data length: ${response.data.length}`);
        log(
          `Response data sample: ${Buffer.from(response.data).slice(0, 10).toString('hex')}`
        );

        const imageBuffer = Buffer.from(response.data);

        // Validate image buffer
        if (!imageBuffer || imageBuffer.length < 1000) {
          throw new Error(
            `Generated image buffer is too small: ${imageBuffer.length} bytes`
          );
        }

        // Check if response is likely a JPEG based on header and content-type
        const isJpeg =
          response.headers['content-type'] === 'image/jpeg' &&
          Buffer.from(response.data)
            .slice(0, 3)
            .toString('hex')
            .startsWith('ffd8ff');
        if (!isJpeg) {
          throw new Error(
            `Invalid image format: content-type=${response.headers['content-type']}`
          );
        }
        log(`Image format: image/jpeg (based on content-type and header)`);

        // Save buffer for debugging
        const debugPath = join(
          tmpdir(),
          `debug_image_${chatId}_${Date.now()}.jpg`
        );
        writeFileSync(debugPath, imageBuffer);
        log(`Saved debug image to ${debugPath}`);

        let caption = isVoice
          ? `این متن صدای شماست: "${text}"\n📷 تصویر تولید شده با پرامپت: "${polishedPrompt}"`
          : `📷 تصویر تولید شده با پرامپت: "${polishedPrompt}"`;

        await sendPhoto(chatId, imageBuffer, caption, updateId);

        await saveChat(
          sess.$id,
          chatId,
          'assistant',
          `تصویر تولید شده با پرامپت: ${polishedPrompt}`,
          updateId
        );

        // Clean up debug image
        if (existsSync(debugPath)) unlinkSync(debugPath);
        log(`Cleaned up debug image: ${debugPath}`);
      } catch (e) {
        error(`Image generation error: ${e.message}`);
        if (e.response) {
          error(`Response data: ${e.response.data.toString('utf-8')}`);
          error(`Response status: ${e.response.status}`);
          error(`Response headers: ${JSON.stringify(e.response.headers)}`);
        }
        const aiResponse = `متأسفم، سرویس تولید تصویر به دلیل خطا در دسترس نیست. لطفاً دوباره تلاش کنید.`;
        await saveChat(sess.$id, chatId, 'assistant', aiResponse, updateId);

        let finalResponse = isVoice
          ? `این متن صدای شماست: "${text}"\n\nو این پاسخ من است: "${aiResponse}"`
          : aiResponse;

        await tg(chatId, finalResponse, { inline_keyboard: menu() }, updateId);
      }
    }
    return res.json({ status: 'ok' }, 200);
  } catch (e) {
    error(`Main execution error: ${e.message}`);
    if (chatId) {
      try {
        await tg(
          chatId,
          `🚨 خطایی رخ داد: ${e.message}\nلطفاً دوباره تلاش کنید یا از دکمه‌های زیر استفاده کنید.`,
          { inline_keyboard: menu() },
          updateId
        );
      } catch (e) {
        error(`tg error in main catch: ${e.message}`);
      }
    }
    return res.json({ status: 'ok' }, 200);
  }

  // Helper Functions
  async function getTelegramFileUrl(fileId) {
    const response = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
    );
    const data = await response.json();
    if (!data.ok) throw new Error(`Failed to get file: ${data.description}`);
    return `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${data.result.file_path}`;
  }

  async function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec('pcm_s16le')
        .format('wav')
        .on('end', () => {
          log(`Converted to ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          error(`FFmpeg conversion error: ${err.message}`);
          reject(err);
        })
        .save(outputPath);
    });
  }

  async function getGenerativeModel(content, task, preferredModel, retryCount) {
    const model = 'gemini-2.0-flash';

    try {
      const generativeModel = genAI.getGenerativeModel({ model });
      const result = await generativeModel.generateContent(content);
      const response = result.response;
      let responseText = '';
      if (
        response.candidates &&
        response.candidates[0] &&
        response.candidates[0].content &&
        response.candidates[0].content.parts &&
        response.candidates[0].content.parts[0] &&
        response.candidates[0].content.parts[0].text
      ) {
        responseText = response.candidates[0].content.parts[0].text;
      } else {
        throw new Error(
          `Invalid response structure from Gemini API for task ${task}`
        );
      }
      log(`Extracted response for ${task}: ${responseText.slice(0, 50)}...`);
      return { text: responseText };
    } catch (e) {
      error(`Model ${model} failed for ${task}: ${e.message}`);
      throw e;
    }
  }

  async function transcribeAudio(audioBuffer, mimeType, fileName) {
    const transcriptionPrompt =
      'لطفاً این فایل صوتی را به متن پارسی دقیق رونویسی کنید. فقط متن رونویسی شده را خروجی دهید بدون هیچ توضیح اضافی.';
    const content = [
      { text: transcriptionPrompt },
      { inlineData: { data: audioBuffer.toString('base64'), mimeType } },
    ];

    try {
      log(
        `Transcribing audio file: ${fileName}, size: ${audioBuffer.length} bytes`
      );
      if (audioBuffer.length === 0)
        throw new Error(`Audio file is empty: ${fileName}`);
      if (audioBuffer.length > 4 * 1024 * 1024)
        throw new Error(
          `Audio file size exceeds 4MB: ${audioBuffer.length} bytes`
        );

      const response = await getGenerativeModel(
        content,
        'Transcribe Audio',
        'gemini-2.0-flash',
        0
      );

      let transcription = response.text.trim();
      log(`Transcription for ${fileName}: ${transcription}`);
      return transcription || '';
    } catch (err) {
      error(`Transcription failed for ${fileName}: ${err.message}`);
      return '';
    }
  }

  async function askAI(prompt) {
    try {
      const response = await getGenerativeModel(
        prompt,
        'Text Generation',
        'gemini-2.0-flash',
        0
      );
      return response.text.trim();
    } catch (e) {
      error(`Gemini error: ${e.message}`);
      log('Falling back to OpenRouter');
      try {
        const requestBody = {
          model: process.env.MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 600,
        };
        const headers = {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        };
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        });
        if (!r.ok) throw new Error(`OpenRouter error: ${await r.text()}`);
        const d = await r.json();
        if (!d.choices || !d.choices[0] || !d.choices[0].message) {
          throw new Error('Invalid OpenRouter response');
        }
        let responseText = d.choices[0].message.content;
        return responseText;
      } catch (openError) {
        error(`OpenRouter error: ${openError.message}`);
        return `⚠️ خطا در دریافت پاسخ از هوش مصنوعی. لطفاً دوباره تلاش کنید یا برای مشاوره حقوقی رایگان دکمه زیر را فشار دهید.`;
      }
    }
  }

  function getMessageType(message) {
    if (!message) return 'پیام نامشخص';
    if (message.photo) return 'عکس';
    if (message.video) return 'ویدیو';
    if (message.document) return 'فایل';
    if (message.sticker) return 'استیکر';
    if (message.audio) return 'صدا';
    if (message.animation) return 'انیمیشن';
    return 'پیام غیرمتنی';
  }

  async function upsertUser(tid) {
    const month = new Date().toISOString().slice(0, 7);
    try {
      const u = await db.listDocuments(
        process.env.DB_ID,
        process.env.USERS_COLLECTION,
        [Query.equal('telegramId', tid)]
      );
      if (u.total === 0) {
        return await db.createDocument(
          process.env.DB_ID,
          process.env.USERS_COLLECTION,
          ID.unique(),
          {
            telegramId: tid,
            month,
            usageCount: 0,
            mode: '',
            activeNoteId: '',
          }
        );
      }
      const doc = u.documents[0];
      const updates = {};
      if (!('mode' in doc)) updates.mode = '';
      if (!('activeNoteId' in doc)) updates.activeNoteId = '';
      if (doc.month !== month) {
        updates.month = month;
        updates.usageCount = 0;
        updates.mode = '';
        updates.activeNoteId = '';
      }
      if (Object.keys(updates).length > 0) {
        return await db.updateDocument(
          process.env.DB_ID,
          process.env.USERS_COLLECTION,
          doc.$id,
          updates
        );
      }
      return doc;
    } catch (e) {
      error(`upsertUser error: ${e.message}`);
      return null;
    }
  }

  async function finishSessions(uid) {
    try {
      const s = await db.listDocuments(
        process.env.DB_ID,
        process.env.SESSIONS_COLLECTION,
        [Query.equal('userId', uid), Query.equal('active', true)]
      );
      for (const doc of s.documents) {
        await db.updateDocument(
          process.env.DB_ID,
          process.env.SESSIONS_COLLECTION,
          doc.$id,
          {
            active: false,
          }
        );
      }
      log(`Finished sessions for user ${uid}`);
    } catch (e) {
      error(`finishSessions error: ${e.message}`);
    }
  }

  async function createSession(uid, context) {
    try {
      const doc = await db.createDocument(
        process.env.DB_ID,
        process.env.SESSIONS_COLLECTION,
        ID.unique(),
        {
          userId: uid,
          active: true,
          context,
        }
      );
      log(`Created session ${doc.$id} for user ${uid}`);
      return doc;
    } catch (e) {
      error(`createSession error: ${e.message}`);
      return null;
    }
  }

  async function getActive(uid) {
    try {
      const s = await db.listDocuments(
        process.env.DB_ID,
        process.env.SESSIONS_COLLECTION,
        [Query.equal('userId', uid), Query.equal('active', true)]
      );
      if (s.total > 0) return s.documents[0];
      return await createSession(uid, '');
    } catch (e) {
      error(`getActive error: ${e.message}`);
      return null;
    }
  }

  async function saveChat(sid, uid, role, content, updateId) {
    try {
      const doc = await db.createDocument(
        process.env.DB_ID,
        process.env.CHATS_COLLECTION,
        ID.unique(),
        {
          sessionId: sid,
          userId: uid,
          role,
          content,
          updateId: updateId ? String(updateId) : null,
        }
      );
      log(
        `Saved chat for session ${sid}, docId: ${doc.$id}, updateId: ${updateId || 'none'}`
      );
    } catch (e) {
      error(`saveChat error: ${e.message}`);
    }
  }

  async function logBlockedUser(chatId, updateId) {
    try {
      const sess = await getActive(chatId);
      await db.createDocument(
        process.env.DB_ID,
        process.env.CHATS_COLLECTION,
        ID.unique(),
        {
          sessionId: sess.$id,
          userId: chatId,
          role: 'system',
          content: 'User blocked the bot',
          updateId: updateId ? String(updateId) : null,
        }
      );
      log(
        `Logged blocked user event for chatId ${chatId}, updateId: ${updateId || 'none'}`
      );
    } catch (e) {
      error(`logBlockedUser error: ${e.message}`);
    }
  }

  async function chatsSession(sid, limit) {
    try {
      const c = await db.listDocuments(
        process.env.DB_ID,
        process.env.CHATS_COLLECTION,
        [
          Query.equal('sessionId', sid),
          Query.orderDesc('$createdAt'),
          Query.limit(limit),
        ]
      );
      return c.documents.reverse();
    } catch (e) {
      error(`chatsSession error: ${e.message}`);
      return [];
    }
  }

  async function chatsUser(uid, limit) {
    try {
      const c = await db.listDocuments(
        process.env.DB_ID,
        process.env.CHATS_COLLECTION,
        [
          Query.equal('userId', uid),
          Query.orderDesc('$createdAt'),
          Query.limit(limit),
        ]
      );
      return c.documents.reverse();
    } catch (e) {
      error(`chatsUser error: ${e.message}`);
      return [];
    }
  }

  async function summarize(chats) {
    if (!chats.length) return '📭 پیامی نیست';
    const concat = chats
      .map((c) => `${c.role === 'user' ? 'کاربر' : 'دستیار'}: ${c.content}`)
      .join('\n');
    return await askAI(
      `متن زیر را خلاصه کن زیر ۱۵۰۰ کاراکتر فارسی:\n${concat}`
    );
  }

  async function tg(chatId, text, reply_markup, updateId) {
    if (!chatId) {
      error('Cannot send Telegram message: chatId is null');
      return;
    }
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            reply_markup,
          }),
        }
      );
      const responseData = await r.json();
      if (!r.ok || responseData.ok === false) {
        const errorMessage =
          responseData.description || 'Unknown Telegram error';
        if (errorMessage.includes('bot was blocked by the user')) {
          await logBlockedUser(chatId, updateId);
          error(
            `User blocked the bot for chatId ${chatId}, updateId: ${updateId || 'none'}`
          );
          return;
        }
        throw new Error(`Telegram API error: ${errorMessage}`);
      }
      log(`Sent Telegram message to chat ${chatId}: ${text.slice(0, 50)}...`);
    } catch (e) {
      error(`tg error: ${e.message}`);
      if (e.message.includes('bot was blocked by the user')) {
        await logBlockedUser(chatId, updateId);
        return;
      }
      throw e;
    }
  }

  async function sendDocument(chatId, filePath, caption, updateId) {
    try {
      const fileBuffer = readFileSync(filePath);

      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('caption', caption);
      formData.append('document', fileBuffer, {
        filename: basename(filePath),
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

      const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendDocument`;

      const response = await axios.post(url, formData, {
        headers: formData.getHeaders(),
      });

      const responseData = response.data;

      if (!responseData.ok) {
        const errorMessage =
          responseData.description || 'Unknown Telegram error';
        if (errorMessage.includes('bot was blocked by the user')) {
          await logBlockedUser(chatId, updateId);
          return;
        }
        throw new Error(`Telegram sendDocument error: ${errorMessage}`);
      }
      log(`Sent document ${filePath} to chat ${chatId}`);
    } catch (e) {
      if (e.response) {
        error(
          `sendDocument API error: ${e.response.status} ${JSON.stringify(e.response.data)}`
        );
      } else {
        error(`sendDocument network error: ${e.message}`);
      }
      throw new Error(e.message);
    }
  }

  async function sendPhoto(chatId, imageBuffer, caption, updateId) {
    try {
      if (!imageBuffer || imageBuffer.length < 1000) {
        throw new Error(
          `Image buffer is too small or empty: ${imageBuffer ? imageBuffer.length : 0} bytes`
        );
      }
      log(`Sending photo with buffer length: ${imageBuffer.length}`);

      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('caption', caption);
      // The form-data library handles Buffers perfectly
      formData.append('photo', imageBuffer, {
        filename: `generated_image_${Date.now()}.jpg`,
        contentType: 'image/jpeg',
      });

      const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendPhoto`;

      // Use axios to send the request
      const response = await axios.post(url, formData, {
        headers: formData.getHeaders(),
      });

      const responseData = response.data; // With axios, the data is in response.data

      if (!responseData.ok) {
        const errorMessage =
          responseData.description || 'Unknown Telegram error';
        if (errorMessage.includes('bot was blocked by the user')) {
          await logBlockedUser(chatId, updateId);
          return;
        }
        throw new Error(`Telegram sendPhoto error: ${errorMessage}`);
      }
      log(`Sent photo to chat ${chatId}`);
    } catch (e) {
      // Axios wraps errors, so we check for more details
      if (e.response) {
        error(
          `sendPhoto API error: ${e.response.status} ${JSON.stringify(e.response.data)}`
        );
      } else {
        error(`sendPhoto network error: ${e.message}`);
      }
      throw new Error(e.message);
    }
  }
  async function createNote(userId) {
    try {
      const doc = await db.createDocument(
        process.env.DB_ID,
        process.env.NOTES_COLLECTION,
        ID.unique(),
        {
          userId,
          createdAt: new Date().toISOString(),
          active: true,
        }
      );
      log(`Created note ${doc.$id} for user ${userId}`);
      return doc;
    } catch (e) {
      error(`createNote error: ${e.message}`);
      return null;
    }
  }

  async function finishNote(userId) {
    try {
      const userState = await getUserState(userId);
      if (userState && userState.activeNoteId) {
        await db.updateDocument(
          process.env.DB_ID,
          process.env.NOTES_COLLECTION,
          userState.activeNoteId,
          {
            active: false,
          }
        );
        await setUserState(userId, '', '');
        log(`Finished note ${userState.activeNoteId} for user ${userId}`);
      }
    } catch (e) {
      error(`finishNote error: ${e.message}`);
    }
  }

  async function saveNoteChunk(noteId, content) {
    try {
      if (!content) throw new Error('Content is empty');
      const doc = await db.createDocument(
        process.env.DB_ID,
        process.env.NOTE_CHUNKS_COLLECTION,
        ID.unique(),
        { noteId, content, createdAt: new Date().toISOString() }
      );
      log(`Saved note chunk for note ${noteId}, docId: ${doc.$id}`);
      return doc;
    } catch (e) {
      error(`saveNoteChunk error: ${e.message}`);
      return null;
    }
  }

  async function getFullNoteText(noteId) {
    try {
      const chunks = await db.listDocuments(
        process.env.DB_ID,
        process.env.NOTE_CHUNKS_COLLECTION,
        [Query.equal('noteId', noteId), Query.orderAsc('$createdAt')]
      );
      const fullText = chunks.documents.map((chunk) => chunk.content).join(' ');
      log(`Retrieved ${chunks.documents.length} chunks for note ${noteId}`);
      return fullText;
    } catch (e) {
      error(`getFullNoteText error: ${e.message}`);
      return '';
    }
  }

  async function setUserState(userId, mode, activeNoteId) {
    try {
      const userDoc = await db.listDocuments(
        process.env.DB_ID,
        process.env.USERS_COLLECTION,
        [Query.equal('telegramId', userId)]
      );
      if (userDoc.total === 0) throw new Error(`User ${userId} not found`);
      await db.updateDocument(
        process.env.DB_ID,
        process.env.USERS_COLLECTION,
        userDoc.documents[0].$id,
        {
          mode,
          activeNoteId,
        }
      );
      log(
        `Set user state for ${userId}: mode=${mode}, activeNoteId=${activeNoteId}`
      );
    } catch (e) {
      error(`setUserState error: ${e.message}`);
    }
  }

  async function getUserState(userId) {
    try {
      const userDoc = await db.listDocuments(
        process.env.DB_ID,
        process.env.USERS_COLLECTION,
        [Query.equal('telegramId', userId)]
      );
      if (userDoc.total === 0) return null;
      return userDoc.documents[0];
    } catch (e) {
      error(`getUserState error: ${e.message}`);
      return null;
    }
  }

  async function createWordDocument(text, chatId) {
    try {
      const doc = new Document({
        sections: [
          {
            properties: {},
            children: [
              new Paragraph({
                children: [new TextRun(text)],
              }),
            ],
          },
        ],
      });
      const docPath = join(tmpdir(), `note_${chatId}_${Date.now()}.docx`);
      const buffer = await Packer.toBuffer(doc);
      writeFileSync(docPath, buffer);
      log(`Created Word document: ${docPath}`);
      return docPath;
    } catch (e) {
      error(`createWordDocument error: ${e.message}`);
      throw e;
    }
  }

  function menu() {
    return [
      [
        { text: '✨ چت جدید', callback_data: '/newchat' },
        { text: '📝 ساخت یادداشت جدید', callback_data: '/makenote' },
      ],
      [
        {
          text: '🔴 لطفاً کانال یوتیوب را دنبال کنید',
          callback_data: '/youtube',
        },
      ],
      [
        { text: '📜 خلاصه ۱۰۰ پیام', callback_data: '/summary100' },
        { text: '📚 خلاصه همه پیام‌ها', callback_data: '/summaryall' },
      ],
      [
        { text: 'ℹ️ راهنما', callback_data: '/help' },
        {
          text: '📝 دریافت مشاوره حقوقی رایگان',
          url: `https://t.me/${VAKIL_JIBI_BOT_URL}`,
        },
      ],
    ];
  }

  function noteMenu() {
    return [
      [
        { text: '📝 ادامه یادداشت', callback_data: 'resume_note' },
        { text: '📋 کپی متن', callback_data: 'copy_note' },
      ],
      [
        { text: '📄 وارد کردن به ورد 📝', callback_data: 'export_to_word' },
        { text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_menu' },
      ],
      [{ text: '📝 ساخت یادداشت جدید دیگر', callback_data: 'make_new_note' }],
    ];
  }
};

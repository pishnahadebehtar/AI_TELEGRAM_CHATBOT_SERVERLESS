import { Client, Databases, ID, Query } from 'node-appwrite';
import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  const TELEGRAM_TOKEN = 'TELEGRAM_TOKEN';
  const OPENROUTER_API_KEY = 'OPENROUTER_API_KEY';
  const APPWRITE_ENDPOINT = 'https://cloud.appwrite.io/v1';
  const APPWRITE_PROJECT_ID = 'APPWRITE_PROJECT_ID';
  const APPWRITE_API_KEY = 'APPWRITE_API_KEY';
  const DB_ID = 'DB_ID';
  const USERS_COLLECTION = 'USERS_COLLECTION';
  const SESSIONS_COLLECTION = 'SESSIONS_COLLECTION';
  const CHATS_COLLECTION = 'CHATS_COLLECTION';
  const MODEL = 'meta-llama/llama-4-maverick:free'; // Kept as requested

  const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

  const db = new Databases(client);

  let body;
  log(`Raw request body: ${req.body}`);
  if (typeof req.body === 'string') {
    try {
      body = JSON.parse(req.body);
    } catch (e) {
      error(`Failed to parse string body: ${e.message}`);
      body = {};
    }
  } else if (typeof req.body === 'object' && req.body !== null) {
    body = req.body;
  } else {
    error('Request body is neither a valid string nor an object');
    body = {};
  }
  log(`Parsed update: ${JSON.stringify(body)}`);

  const { message, update_id, callback_query } = body;
  let chatId, text;

  // Handle callback query from inline buttons
  if (callback_query) {
    chatId = callback_query.message.chat.id.toString();
    text = callback_query.data; // This will be the command (e.g., "/newchat")
    log(`Received callback query from chat ${chatId}: "${text}"`);
  } else if (message) {
    chatId = message.chat.id.toString();
    text = (message.text ?? '').trim();
    log(
      `Processing message from chat ${chatId}: "${text}" (update_id: ${update_id})`
    );
  } else {
    log(
      `No message or callback in update (update_id: ${update_id || 'unknown'})`
    );
    return res.json({ status: 'ok' });
  }

  try {
    const user = await upsertUser(chatId);
    if (!user) {
      await tg(chatId, '🚫 خطا در ثبت کاربر', menu());
      return res.json({ status: 'ok' });
    }
    if (user.usageCount >= 400) {
      await tg(chatId, '⛔ سقف مصرف ماهانه پر شده', menu());
      return res.json({ status: 'ok' });
    }

    if (/^\/start/i.test(text)) {
      log('Handling /start command');
      await tg(
        chatId,
        '👋 سلام! من ربات چت هوشمند هستم.\nپیام بفرستید یا از دکمه‌ها استفاده کنید تا با من چت کنید!',
        menu()
      );
      return res.json({ status: 'ok' });
    }
    if (/^\/help/i.test(text)) {
      log('Handling /help command');
      await tg(
        chatId,
        'ℹ️ راهنما:\n/start - شروع چت\n/newchat - چت جدید\n/summary100 - خلاصه ۱۰۰ پیام\n/summaryall - خلاصه همه پیام‌ها\n/youtube - لینک کانال',
        menu()
      );
      return res.json({ status: 'ok' });
    }
    if (/^\/youtube/i.test(text)) {
      log('Handling /youtube command');
      await tg(
        chatId,
        '🌟 اگه از این چت‌بات هوشمند رایگان لذت می‌برید، لطفاً به کانال یوتیوب ما سر بزنید و سابسکرایب کنید! 👇\nhttps://www.youtube.com/@pishnahadebehtar',
        menu()
      );
      return res.json({ status: 'ok' });
    }
    if (/^\/newchat/i.test(text)) {
      log('Handling /newchat command');
      await finishSessions(chatId);
      await createSession(chatId, '');
      await tg(
        chatId,
        '✨ چت جدید آغاز شد!\nپیام جدیدی بفرستید تا دوباره شروع کنیم.',
        menu()
      );
      return res.json({ status: 'ok' });
    }
    if (/^\/summary(all|100)/i.test(text)) {
      log('Handling summary command');
      const lim = text.includes('100') ? 100 : 1000;
      const chats = await chatsUser(chatId, lim);
      const sum = await summarize(chats);
      const sess = await getActive(chatId);
      await db.updateDocument(DB_ID, SESSIONS_COLLECTION, sess.$id, {
        context: sum,
      });
      await tg(
        chatId,
        `📝 خلاصه ایجاد شد!\n${sum}\nبرای ادامه چت، پیام بفرستید.`,
        menu()
      );
      return res.json({ status: 'ok' });
    }

    log('Processing as chat message');
    const sess = await getActive(chatId);
    await saveChat(sess.$id, chatId, 'user', text);
    const history = await chatsSession(sess.$id, 10);

    let prompt = `سابقه:\n${sess.context || 'ندارد'}\n\n`;
    history.forEach((c) => {
      prompt += `${c.role === 'user' ? 'کاربر' : 'دستیار'}: ${c.content}\n`;
    });
    prompt += `\nپیام کاربر:\n${text}\nپاسخ به فارسی (حداکثر ۱۵۰۰ کاراکتر)`; // 1500 character limit

    const aiResponse = await askAI(prompt).catch((e) => {
      error(`AI processing error: ${e.message}`);
      return '⚠️ خطا در دریافت پاسخ از هوش مصنوعی. لطفاً دوباره تلاش کنید.';
    });

    await saveChat(sess.$id, chatId, 'assistant', aiResponse);
    await db.updateDocument(DB_ID, USERS_COLLECTION, user.$id, {
      usageCount: user.usageCount + 1,
    });
    await tg(chatId, aiResponse, menu());

    return res.json({ status: 'ok' });
  } catch (e) {
    error(`Main execution error: ${e.message}`);
    await tg(chatId, '🚨 خطایی رخ داد! لطفاً دوباره تلاش کنید.', menu());
    return res.json({ status: 'ok' });
  }

  async function upsertUser(tid) {
    const month = new Date().toISOString().slice(0, 7);
    try {
      const u = await db.listDocuments(DB_ID, USERS_COLLECTION, [
        Query.equal('telegramId', tid),
      ]);
      if (u.total === 0) {
        log(`Creating new user for telegramId: ${tid}`);
        return await db.createDocument(DB_ID, USERS_COLLECTION, ID.unique(), {
          telegramId: tid,
          month,
          usageCount: 0,
        });
      }
      const doc = u.documents[0];
      if (doc.month !== month) {
        log(`Resetting user month for telegramId: ${tid}`);
        return await db.updateDocument(DB_ID, USERS_COLLECTION, doc.$id, {
          month,
          usageCount: 0,
        });
      }
      return doc;
    } catch (e) {
      error(`upsertUser error: ${e.message}`);
      return null;
    }
  }

  async function finishSessions(uid) {
    try {
      const s = await db.listDocuments(DB_ID, SESSIONS_COLLECTION, [
        Query.equal('userId', uid),
        Query.equal('active', true),
      ]);
      for (const doc of s.documents) {
        await db.updateDocument(DB_ID, SESSIONS_COLLECTION, doc.$id, {
          active: false,
        });
      }
      log(`Finished ${s.total} sessions for user ${uid}`);
    } catch (e) {
      error(`finishSessions error: ${e.message}`);
    }
  }

  async function createSession(uid, context) {
    try {
      const doc = await db.createDocument(
        DB_ID,
        SESSIONS_COLLECTION,
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
      const s = await db.listDocuments(DB_ID, SESSIONS_COLLECTION, [
        Query.equal('userId', uid),
        Query.equal('active', true),
      ]);
      if (s.total > 0) return s.documents[0];
      return await createSession(uid, '');
    } catch (e) {
      error(`getActive error: ${e.message}`);
      return null;
    }
  }

  async function saveChat(sid, uid, role, content) {
    try {
      const doc = await db.createDocument(
        DB_ID,
        CHATS_COLLECTION,
        ID.unique(),
        {
          sessionId: sid,
          userId: uid,
          role,
          content,
        }
      );
      log(`Saved chat ${doc.$id} in session ${sid}`);
    } catch (e) {
      error(`saveChat error: ${e.message}`);
    }
  }

  async function chatsSession(sid, limit) {
    try {
      const c = await db.listDocuments(DB_ID, CHATS_COLLECTION, [
        Query.equal('sessionId', sid),
        Query.orderDesc('$createdAt'),
        Query.limit(limit),
      ]);
      return c.documents.reverse();
    } catch (e) {
      error(`chatsSession error: ${e.message}`);
      return [];
    }
  }

  async function chatsUser(uid, limit) {
    try {
      const c = await db.listDocuments(DB_ID, CHATS_COLLECTION, [
        Query.equal('userId', uid),
        Query.orderDesc('$createdAt'),
        Query.limit(limit),
      ]);
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
      `متن زیر را خلاصه کن زیر ۱۵۰۰ کاراکتر فارسی:\n${concat}` // 1500 character limit
    );
  }

  async function askAI(prompt) {
    log(`Calling askAI with prompt: ${prompt.slice(0, 100)}...`);
    try {
      const requestBody = {
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600, // ~1500 characters
      };
      const headers = {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      };
      log(`Request headers: ${JSON.stringify(headers)}`);
      log(`Request body: ${JSON.stringify(requestBody)}`);

      const startTime = Date.now();
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody),
      });
      const duration = Date.now() - startTime;
      log(`API call took ${duration}ms`);

      log(`Response status: ${r.status} ${r.statusText}`);
      if (!r.ok) {
        const errorText = await r.text();
        throw new Error(`HTTP ${r.status}: ${errorText}`);
      }

      const d = await r.json();
      log(`Response data: ${JSON.stringify(d)}`);

      if (!d.choices || !d.choices[0] || !d.choices[0].message) {
        throw new Error('Invalid response format: no choices available');
      }

      return d.choices[0].message.content || 'پاسخی نبود';
    } catch (e) {
      error(`askAI error: ${e.message}`);
      return '⚠️ خطا در دریافت پاسخ از هوش مصنوعی. لطفاً دوباره تلاش کنید.';
    }
  }

  async function tg(chatId, text, reply_markup) {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
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
      const responseText = await r.text();
      if (!r.ok) error(`Telegram API error: ${r.status} - ${responseText}`);
      log(`Sent message to chat ${chatId}: ${text}`);
    } catch (e) {
      error(`tg error: ${e.message}`);
    }
  }

  function menu() {
    return {
      inline_keyboard: [
        [
          { text: '✨ چت جدید', callback_data: '/newchat' },
          {
            text: '🔴 لطفاً کانال یوتیوب را دنبال کنید',
            callback_data: '/youtube',
          },
        ],
        [
          { text: '📜 خلاصه ۱۰۰ پیام', callback_data: '/summary100' },
          { text: '📚 خلاصه همه پیام‌ها', callback_data: '/summaryall' },
        ],
        [{ text: 'ℹ️ راهنما', callback_data: '/help' }],
      ],
    };
  }
};

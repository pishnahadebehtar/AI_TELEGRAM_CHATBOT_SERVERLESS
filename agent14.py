import requests

url = "https://amozesh.pishnahadebehtar.workers.dev/"
api_key = "123456789"
prompt = "a beautiful women with red hair"

headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json"
}

data = {
    "prompt": prompt
}

response = requests.post(url, headers=headers, json=data)

if response.status_code == 200:
    with open("output.jpg", "wb") as f:
        f.write(response.content)
    print("Image saved as output.jpg")
else:
    print(f"Error: {response.status_code}, {response.text}")
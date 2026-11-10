# MyVault — आपकी Personal Internet Library

Frontend (`index.html`) GitHub Pages पर चलता है, backend (`worker.js`) Cloudflare Worker पर, और सारा डेटा आपकी **private** GitHub repo `MyVault-Data` में JSON फाइलों में रहता है। Browser में कोई resource डेटा नहीं रखा जाता।

## फाइलें
`index.html` (पूरा frontend) · `worker.js` (backend) · `wrangler.jsonc` (config) · `.gitignore` · `.dev.vars.example`

## Deploy कैसे करें
1. **Public repo:** github.com → ऊपर दाएँ **+ → New repository** → नाम `MyVault`, **Public** → Create। फिर **Add file → Upload files** से `index.html` डालें।
2. **GitHub Pages:** repo में **Settings → Pages → Branch: main / (root) → Save**। कुछ मिनट बाद लिंक मिलेगा: `https://USERNAME.github.io/MyVault/`
3. **Private repo:** **+ → New repository** → नाम `MyVault-Data`, **Private**, "Add a README" टिक करें → Create।
4. **Fine-grained PAT:** profile फोटो → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**। Repository access: **Only select repositories → MyVault-Data**। Permissions → **Contents: Read and write**। Token बनाकर कॉपी करें (इसे किसी को न भेजें, चैट में भी नहीं)।
5. **अपना numeric GitHub ID:** browser में `https://api.github.com/users/आपका_USERNAME` खोलें और `"id"` वाला नंबर देखें।
6. **Cloudflare:** cloudflare.com पर free account बनाएँ → **Workers & Pages → Create → Worker** → नाम `myvault-api` → Deploy → **Edit code** में `worker.js` की पूरी सामग्री paste करके **Deploy**। Worker URL (`https://myvault-api.XXXX.workers.dev`) नोट करें।
7. **GitHub OAuth App:** GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**। Homepage URL: आपका Pages लिंक। **Authorization callback URL:** `https://myvault-api.XXXX.workers.dev/auth/github/callback` (बिल्कुल यही)। बनाने के बाद **Client ID** नोट करें और **Generate a new client secret** दबाकर secret कॉपी करें।
8. **Worker Variables (non-secret):** Worker → **Settings → Variables and Secrets → Add → Type: Text**। जोड़ें: `GITHUB_OWNER`, `GITHUB_DATA_REPO` (=MyVault-Data), `GITHUB_DATA_BRANCH` (=main), `ALLOWED_GITHUB_ID`, `FRONTEND_ORIGIN` (=`https://USERNAME.github.io`, अंत में `/` नहीं), `FRONTEND_URL` (=पूरा Pages लिंक, अंत में `/`), `GITHUB_OAUTH_CLIENT_ID`।
9. **Worker Secrets:** उसी जगह **Type: Secret** चुनकर जोड़ें: `GITHUB_PAT`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SIGNING_SECRET`, `OAUTH_STATE_SECRET`। बाद वाले दोनों के लिए कम से कम 32 अक्षरों की random string बनाएँ (जैसे password manager से)। **Deploy** दबाएँ।
10. **Frontend जोड़ें:** `index.html` में ऊपर के पास `const API_BASE = '...'` में अपना Worker URL डालें। ध्यान दें: बदलाव के बाद CSP hash बदल जाता है — नीचे "index.html बदलने पर" देखें। फिर GitHub repo में फाइल दोबारा upload करें।
11. **Test:** Pages लिंक खोलें → **Continue with GitHub** → login के बाद Dashboard दिखेगा → एक resource जोड़ें → `MyVault-Data` repo में `manifest.json` और `data/items/part-0001.json` बनी दिखनी चाहिए। फिर फोन और लैपटॉप दोनों पर खोलकर **Sync** बटन से जाँचें।

## index.html बदलने पर (CSP hash)
Page में `<style>` या `<script>` बदलते ही उनके SHA-256 hash बदलते हैं। अपने computer के terminal में फाइल वाले फ़ोल्डर में यह चलाएँ (Python 3 चाहिए):
```
python3 -c "import re,hashlib,base64;s=open('index.html',encoding='utf-8').read();f=lambda t:base64.b64encode(hashlib.sha256(t.encode()).digest()).decode();print('style',f(re.search(r'<style>(.*?)</style>',s,re.S).group(1)));print('script',f(re.search(r'<script>(.*?)</script>',s,re.S).group(1)))"
```
मिले हुए मान `Content-Security-Policy` meta टैग के `sha256-...` में बदलें।

## Secret बदलना (rotate)
नया PAT / OAuth secret बनाएँ → Worker **Settings → Variables and Secrets** में उसी नाम का secret edit करें → Deploy। `SESSION_SIGNING_SECRET` बदलने पर सभी login तुरंत रद्द हो जाते हैं।

## सुरक्षा नोट
- Session token 2 घंटे का है। Logout सिर्फ इस device से token हटाता है; कॉपी किया हुआ token expiry तक valid रहेगा।
- GitHub Contents API transactional नहीं है। Conflict पर Worker नया डेटा लेकर सीमित बार retry करता है, और आपके edit पर `updatedAt` से बदलाव पकड़ता है।
- Limits: 200 records या ~500 KB प्रति partition, अधिकतम 20 partitions (Cloudflare free subrequest limit के कारण)। Free plan की सीमाएँ बदल सकती हैं — Cloudflare और GitHub के official docs देखें।

## आम दिक्कतें
- **"This GitHub account is not authorized":** `ALLOWED_GITHUB_ID` गलत है।
- **Login के बाद error / CORS:** `FRONTEND_ORIGIN` में path या अंत का `/` न हो।
- **Callback mismatch:** OAuth App की callback URL Worker URL से बिल्कुल मेल खाए।
- **GitHub error (502):** PAT की Contents Read/Write permission और repo नाम जाँचें।
- **Blank page / CSP error:** `index.html` बदलने के बाद hash अपडेट नहीं किए।

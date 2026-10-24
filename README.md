# Hans AI Coder: setup guide

An AI coding assistant you use from your phone. It reads your GitHub code, writes changes, and shows them to you. **Nothing is pushed until you tap Approve.**

You get 3 files:
- `index.html`: the chat app (goes on GitHub Pages)
- `worker.js`: the small server (goes on Cloudflare, holds your secret keys)
- `README.md`: this guide.

Total cost: free to start. Time: about 20 minutes.

---

## Step 1: Get a free Gemini key
1. Open **aistudio.google.com/apikey** and sign in with Google.
2. Tap **Create API key** and copy it. Keep it private.

## Step 2: Make a GitHub token
1. On GitHub: your profile picture, **Settings**, **Developer settings**, **Personal access tokens**, **Fine-grained tokens**, **Generate new token**.
2. Name it `hans-ai-coder`. Set the expiry to 90 days.
3. **Repository access:** choose **Only select repositories**, then pick only the repos the AI may change.
4. **Permissions:** open **Repository permissions** and set **Contents** to **Read and write**.
5. Tap **Generate token** and copy it (it starts with `github_pat_`). You can't see it again.

## Step 3: Put the server on Cloudflare
1. Open **dash.cloudflare.com** and make a free account.
2. Go to **Workers & Pages**, then **Create**, then **Create Worker**. Name it `hans-ai-coder` and tap **Deploy**.
3. Tap **Edit code**. Select everything, delete it, and paste all of `worker.js`. Tap **Deploy**.
4. Open the Worker's **Settings**, then **Variables and Secrets**, and add three **Secrets**:
   - `APP_PASSCODE`: make up a long passcode. This is your app login.
   - `GITHUB_TOKEN`: the token from Step 2
   - `GEMINI_API_KEY`: the key from Step 1
5. Tap **Deploy** again. Copy your Worker address. It looks like `https://hans-ai-coder.yourname.workers.dev`.

(Optional: add a text variable `GEMINI_MODEL` if you want a different Gemini model. The default is `gemini-2.5-flash`.)

## Step 4: Put the app online
1. Make a new **public** GitHub repo called `hans-ai-coder-app`.
2. Upload `index.html` to it. It contains no secrets.
3. Open the repo's **Settings**, then **Pages**. Under **Deploy from a branch**, choose `main` and `/ (root)`, then **Save**.
4. After 1 to 2 minutes your app is at `https://YOURNAME.github.io/hans-ai-coder-app/`. Open it on your phone and choose **Add to Home screen**.

## Step 5: Connect
1. In the app, tap the gear icon.
2. Paste your Worker address and your passcode, then tap **Connect**.
3. Choose the repository to work on, and tap **Save**.

---

When the AI changes code you see a **Proposed changes** card. Tap **View** on each file to see exactly what changes (red is removed, green is added). Then:
- **Approve and push** makes one commit to your repo. You can tick "Push to a new branch" to keep your main branch untouched.
- **Reject** throws the proposal away.

If a push turns out wrong, undo it on GitHub by reverting the commit.

## Safety
- The AI can only change repos you gave the token, and only after you approve.
- Keep your passcode long and private. Anyone with the Worker address and passcode can use your AI key.
- The free Gemini tier may use your prompts to improve Google products, so don't use it on private code you can't share.
- Delete the GitHub token if you stop using the app.

## Limits (version 1)
- One message can use about 40 outside requests (a Cloudflare free plan limit), so for big jobs ask for one part at a time.
- It reads big files in parts and changes them with find and replace, so even a very large file works.
- It can't run your code or start GitHub Actions builds yet. That is the next step.

## If something goes wrong
- **Wrong passcode:** the passcode in the app must match `APP_PASSCODE` exactly.
- **Cannot reach the Worker:** check the address, and that you tapped Deploy.
- **GitHub 404 or 403:** the token doesn't include that repo, or Contents is not set to Read and write.
- **The free AI limit was reached:** wait a minute and try again.
- **AI error 400 or 404 about the model:** add the `GEMINI_MODEL` variable with a current model name.

## Next steps
- Switch to Claude's API for stronger coding.
- Let the AI start a build in GitHub Actions, read the errors, and fix them.
- Build the app into an Android APK.

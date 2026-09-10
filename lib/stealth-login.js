// stealth-login.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');

// Where we save the stolen session
const SESSION_FILE = path.resolve('./chatgpt-session.json');

(async () => {
  console.log("[+] Launching stealth browser...");

  const browser = await puppeteer.launch({
    headless: false, // MUST be false — look human
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-position=500,200',
      '--window-size=1024,768',
      '--disable-blink-features=AutomationControlled'
    ],
    defaultViewport: null
  });

  const page = await browser.newPage();

  // Fake human fingerprint
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    navigator.permissions = {
      query: () => Promise.resolve({ state: 'granted' })
    };
  });

  await page.goto('https://chat.openai.com/auth/login', { waitUntil: 'networkidle2' });
  console.log("[+] ChatGPT login page loaded.");

  // WAIT FOR YOU TO LOG IN
  console.log("\n⚠️  MANUAL ACTION REQUIRED:");
  console.log("👉 Log in with your OpenAI account.");
  console.log("👉 Do NOT enable 2FA if you want auto-login later.");
  console.log("👉 Wait for the chat interface to fully load.");
  console.log("✅ Close the browser window when done.\n");

  // Wait until you see the chat input box (proof you're logged in)
  try {
    await page.waitForSelector('textarea', { timeout: 120000 }); // 2 min wait
    console.log("[+] Detected chat input. You're logged in.");
  } catch {
    console.log("❌ Timeout: You didn't log in in time.");
    await browser.close();
    return;
  }

  // Now grab the session from localStorage
  const sessionData = await page.evaluate(() => {
    return localStorage.getItem('oai/apps/auth0');
  });

  if (!sessionData) {
    console.log("❌ Failed to extract session data.");
    await browser.close();
    return;
  }

  const auth = JSON.parse(sessionData);
  if (!auth?.accessToken) {
    console.log("❌ No access token found.");
    await browser.close();
    return;
  }

  // Save session to disk
  const session = {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken || '',
    email: auth.email || 'unknown',
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
  };

  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  console.log(`\n[✔] Session saved to ${SESSION_FILE}`);
  console.log(`🔑 Token: ${auth.accessToken.substring(0, 20)}...`);

  // Close browser
  await browser.close();
  console.log("[+] Close this terminal. Run agent now.");
})();

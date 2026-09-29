import { login, PATHS, PORTAL_ORIGIN, type LoginPrompts } from "@clalit/core";
import { ask } from "./prompt.js";
import { saveSession } from "./store.js";

const LOGIN_PORTAL_URL = `${PORTAL_ORIGIN}${PATHS.loginFoot}`;

export async function runLogin(idNumber?: string): Promise<number> {
  const id = idNumber ?? (await ask("Israeli ID number (תעודת זהות): "));
  const prompts: LoginPrompts = {
    async solveCaptcha(challenge) {
      console.error("");
      console.error("Clalit shows a CAPTCHA on the login page (BotDetect).");
      console.error("This tool does not bypass Imperva or solve CAPTCHA automatically.");
      console.error("Open the portal in your browser on this machine if the image is unclear.");
      console.error(LOGIN_PORTAL_URL);
      if (challenge.captchaFieldName) {
        console.error(`Captcha field: ${challenge.captchaFieldName}`);
      }
      console.error("");
      return ask("CAPTCHA text: ");
    },
    async readOtp(challenge) {
      console.error(challenge.message);
      return ask("SMS OTP: ");
    },
  };

  try {
    const client = await login(id, prompts);
    const session = await client.exportSession();
    await saveSession(session);
    console.log("Signed in. Session saved under the clalit-mcp config directory (mode 0600).");
    console.log("Idle sessions expire after ~30 minutes of inactivity. Re-run login when reads fail.");
    return 0;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
    if (code === "BOT_CHALLENGE") {
      console.error(
        "Imperva blocked this host (often Error 16 on datacenter/cloud IPs).",
      );
      console.error(
        "Run `clalit-mcp login` on your own Mac/home network. Never bypass Imperva.",
      );
      return 3;
    }
    if (code === "TIMEOUT" || code === "CAPTCHA_CHECK_TIMEOUT") {
      console.error(
        "Checking CAPTCHA timed out. Clalit did not reach the SMS OTP step in time (~30s).",
      );
      console.error("Try again, or use `clalit-mcp login --http` if the image is hard to read in the terminal.");
      return 1;
    }
    if (code === "CAPTCHA_REJECTED" || code === "OTP_PAGE_MISSING") {
      console.error(err instanceof Error ? err.message : "CAPTCHA check failed.");
      console.error("Try again (refresh CAPTCHA), or use `clalit-mcp login --http`.");
      return 1;
    }
    console.error(err instanceof Error ? err.message : "Login failed.");
    return 1;
  }
}

# Authentication

## Upstream flow (observed, Gate 2 HAR)

Host: `https://e-services.clalit.co.il`

1. `POST /onlineweb/general/infootplogin.aspx`  
   Fields include `tbUserId`, `tbCaptchaLogin`, BotDetect captcha id field, plus `__VIEWSTATE` / `__EVENTVALIDATION`.
2. `GET/POST /OnlineWeb/General/OTPSMSVerification.aspx`  
   Field `txtClientOTP`.
3. `GET /OnlineWeb/General/Login.aspx` — 302 into the portal session.

No JSON auth API was observed. This is ASP.NET WebForms end-to-end.

## Imperva

The site is fronted by Imperva. Headless datacenter clients often receive **Error 16**. This package:

- Does **not** bypass Imperva
- Does **not** solve CAPTCHA
- Expects a human on a residential / normal user machine

## Browser login (`login --http`)

Same CAPTCHA + SMS OTP flow as terminal login, but prompts run on a **loopback** page (`http://127.0.0.1:<port>/`). The CAPTCHA image is fetched with the login cookie jar and shown in the page when possible. Writes the same `session.json`. Does **not** bypass Imperva or solve CAPTCHA.

## What we store

Config directory (mode `0700`), resolved as:

1. `CLALIT_CONFIG_DIR` if set
2. `$XDG_CONFIG_HOME/clalit-mcp`
3. `~/.config/clalit-mcp`

Files:

| File | Contents | Mode |
| --- | --- | --- |
| `session.json` | Serialized cookie jar + `authenticatedAt` | `0600` |

Never log cookie values. Never commit this directory.

## Idle TTL

Portal session TTL was **not measured** in Gate 2. Default soft idle hint: **~10 minutes**. Longer idle → expect `REAUTHENTICATION_REQUIRED` and run `login` again.

## Keep-alive

`GET /OnlineWeb/ServicesForAll/RefreshSession.aspx` was observed returning small HTML. Optional CLI: `clalit-mcp refresh-session`. Use sparingly; it does not replace login and must not be used to probe Imperva.

## Owner scope

The portal HTML may include family slider fields (`FamilySliderControl21$au` / `$cu`). The client **never** posts a member switch. Detail refs must come from the owner's own `LabsTestList.aspx` links only.

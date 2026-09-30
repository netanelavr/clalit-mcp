# Authentication

## Upstream flow (observed, Gate 2 HAR)

Host: `https://e-services.clalit.co.il`

1. `POST /onlineweb/general/infootplogin.aspx`  
   Live fields (2026-09): `ctl00$cphBody$tbUserId`, `ctl00$cphBody$tbCaptchaLogin`, BotDetect `LBD_VCID_…` (hidden instance id; image query uses `t=`), `__EVENTTARGET=ctl00$cphBody$btnSendOTP` (LinkButton, not a type=submit), plus `__VIEWSTATE` / `__EVENTVALIDATION`. Older `BDC_VCID_*` + `btnLogin` submit shapes are still accepted when present.
2. `GET/POST /OnlineWeb/General/OTPSMSVerification.aspx`  
   Field `ctl00$cphBody$txtClientOTP`. Continue is the LinkButton `__EVENTTARGET=ctl00$cphBody$btnContinue$lnkSubButton` (not an empty postback). A correct postback returns `PostOtpAuth` (Set-Cookie or `document.cookie`) and a redirect / Object-moved to Login.
3. `GET /OnlineWeb/General/Login.aspx` — only after that postback (often 302). Sets `AfterLogin`. A cold GET without `PostOtpAuth` only sets `.ONLINEAUTH` and labs still redirects to login.

No JSON auth API was observed. This is ASP.NET WebForms end-to-end.

## Imperva

The site is fronted by Imperva. Headless datacenter clients often receive **Error 16**. This package:

- Does **not** bypass Imperva
- Does **not** solve CAPTCHA
- Expects a human on a residential / normal user machine

## Browser login (`login --http`)

Same CAPTCHA + SMS OTP flow as terminal login, but prompts run on a **loopback** page (`http://127.0.0.1:<port>/`). The CAPTCHA image is fetched with the login cookie jar and shown in the page when possible. Writes the same `session.json`. Does **not** bypass Imperva or solve CAPTCHA.

Form posts use **303 See Other** (PRG) so Refresh / double-Continue cannot replay a CAPTCHA or OTP POST into a cleared waiter. Answers are buffered if Continue races ahead of the portal prompt. Only one `login --http` may run at a time (lockfile). Loopback session budget: **~30 minutes**.

After CAPTCHA Continue, the client POSTs to Clalit, follows redirects (or GETs the OTP page), and must reach SMS OTP **or** surface a clear error within **~30 seconds** (transport abort + captcha-check budget). Waiting pages auto-refresh every 2s so OTP / failure UI appears without a manual reload. If the browser UI stalls, use terminal fallback: `clalit-mcp login`.

## What we store

Config directory (mode `0700`), resolved as:

1. `CLALIT_CONFIG_DIR` if set
2. `$XDG_CONFIG_HOME/clalit-mcp`
3. `~/.config/clalit-mcp`

Files:

| File | Contents | Mode |
| --- | --- | --- |
| `session.json` | Serialized cookie jar + `authenticatedAt` | `0600` |
| `captcha-rejected-*.json` | Redacted CAPTCHA_REJECTED dump (HTML field shape + POST **keys** only; no ID/captcha/viewstate values) | `0600` |
| `login-hops-*.json` | Redacted OTP→portal hop dump (URL/status/Set-Cookie **names**/jar **names** only) | `0600` |

Never log cookie values. Never commit this directory.

## Session completeness (fail-closed)

After SMS OTP, login **does not** write `session.json` unless:

1. The cookie jar contains at least one Imperva/TS-style name (`visid_incap_*`, `incap_ses_*`, `TS…`, or `_cls_*`), and
2. A probe of `LabsTestList.aspx` does **not** 302/HTML-redirect to Login.

A redacted `login-hops-*.json` dump (per-hop URL, status, Set-Cookie **names**, jar **names**, final count) is written under the config directory — never cookie values.

On a residential Mac, login optionally warms those defense cookies via **Playwright** (Chrome channel when available) before the Node CAPTCHA/OTP chain, then merges `Domain=.clalit.co.il` cookies into the tough-cookie jar with `loose` parsing.


## Idle TTL

Portal session TTL was **not measured** in Gate 2. Default soft idle hint: **~30 minutes**. Longer idle → expect `REAUTHENTICATION_REQUIRED` and run `login` again.

## Keep-alive

`GET /OnlineWeb/ServicesForAll/RefreshSession.aspx` was observed returning small HTML. Optional CLI: `clalit-mcp refresh-session`. Use sparingly; it does not replace login and must not be used to probe Imperva.

## Owner scope

The portal HTML may include family slider fields (`FamilySliderControl21$au` / `$cu`). The client **never** posts a member switch. Detail refs must come from the owner's own `LabsTestList.aspx` links only.

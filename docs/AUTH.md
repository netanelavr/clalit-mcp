# Authentication

## Upstream flow (observed, redacted endpoint map)

Host: `https://e-services.clalit.co.il`

1. `POST /onlineweb/general/infootplogin.aspx`  
   Live fields (2026-09): `ctl00$cphBody$tbUserId`, `ctl00$cphBody$tbCaptchaLogin`, BotDetect `LBD_VCID_…` (hidden instance id; image query uses `t=`), `__EVENTTARGET=ctl00$cphBody$btnSendOTP` (LinkButton, not a type=submit), plus `__VIEWSTATE` / `__EVENTVALIDATION`. Older `BDC_VCID_*` + `btnLogin` submit shapes are still accepted when present.
2. `GET/POST /OnlineWeb/General/OTPSMSVerification.aspx`  
   Field `ctl00$cphBody$txtClientOTP`, plus hidden `ctl00$cphBody$hdnRegExp` when present (`^[0-9]{6,6}$`). Continue is the LinkButton `__EVENTTARGET=ctl00$cphBody$btnContinue$lnkSubButton`. Live HTML encodes `__doPostBack` quotes as `&#39;` / `&apos;` — parsers must accept those or EVENTTARGET stays empty and the OTP form redisplays (HTTP 200, no `PostOtpAuth`).
3. Successful postback: **302 → `PersonalDetails.aspx`** (sets `PostOtpAuth` / portal auth). Not a cold `Login.aspx`. A cold `Login.aspx` GET without `PostOtpAuth` only sets `.ONLINEAUTH` and labs still redirects to login.

No JSON auth API was observed. This is ASP.NET WebForms end-to-end.

## Imperva

The site is fronted by Imperva. Headless datacenter clients often receive **Error 16**. This package:

- Does **not** bypass Imperva
- Does **not** solve CAPTCHA
- Expects a human on a residential / normal user machine

## Browser login (`login`)

`clalit-mcp login` opens a **loopback** page (`http://127.0.0.1:<port>/`) for Israeli ID, CAPTCHA, and SMS OTP. The CAPTCHA image is fetched with the login cookie jar and shown in the page when possible. Writes `session.json`. Does **not** bypass Imperva or solve CAPTCHA. `--http` is accepted as a no-op alias.

Form posts use **303 See Other** (PRG) so Refresh / double-Continue cannot replay a CAPTCHA or OTP POST into a cleared waiter. Answers are buffered if Continue races ahead of the portal prompt. Only one `login` may run at a time (lockfile). Loopback session budget: **~30 minutes**.

After CAPTCHA Continue, the client POSTs to Clalit, follows redirects (or GETs the OTP page), and must reach SMS OTP **or** surface a clear error within **~30 seconds** (transport abort + captcha-check budget). Waiting pages auto-refresh every 2s so OTP / failure UI appears without a manual reload.

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
| `otp-redisplay-*.json` | When OTP POST returns 200 still showing the form: posted **field names**, `__EVENTTARGET` used, and (v2) a redacted `otpPost` summary: page kind, presence flags, missing/unexpected keys, source page, digit-stripped validation text, cookie **names** before/after, timings (never OTP/ID/cookie/viewstate values) | `0600` |

Never log cookie values. Never commit this directory.

## Session completeness (fail-closed)

After SMS OTP, login **does not** write `session.json` unless:

1. The cookie jar contains at least one Imperva/TS-style name (`visid_incap_*`, `incap_ses_*`, `TS…`, or `_cls_*`), and
2. A probe of `LabsTestList.aspx` does **not** 302/HTML-redirect to Login.

A redacted `login-hops-*.json` dump (per-hop URL, status, content-type, Location path, page kind, Set-Cookie **names**, jar **names**, final count) is written under the config directory — never cookie values.

### Reading a failed-login dump

Start with `why.why` in the newest `login-hops-*.json`. The same reason code is on the `login` error page and in the stderr `[clalit login] why:` line.

- `otp_redisplayed_with_error`: the portal showed the OTP form again with a visible error. See `otpPost.validationSnippets[].text` (digits shown as `#`). This is usually a wrong or expired code, so request a new SMS.
- `otp_redisplayed_silent`: the form came back with no visible error. Compare `otpPost.post.missingExpectedKeys` with `otpPost.responseForm`.
- `otp_source_not_otp_form`: the OTP POST was built from a page without the SMS input. `otpPost.source.path` and `otpPost.source.presence` show which page. `otpPost.post.unexpectedLoginKeys` lists login or CAPTCHA keys that leaked into the POST.
- `otp_post_form_action_mismatch`: the page's `<form action>` differs from the POST URL.
- `otp_event_target_empty`: the POST had an empty `__EVENTTARGET`, so Continue never registered as clicked.
- `missing_post_otp_auth`: the client left the OTP form, but no `PostOtpAuth` or `AfterLogin` cookie arrived. See `hops[].pageKind`, `locationPath`, and `setCookieNames`.
- `missing_portal_defense_cookies`: no Imperva or TS defense cookies were found.
- `labs_login_redirect`: auth cookies arrived, but labs still redirects to sign-in.

`why.signals` adds hints such as `otp_entry_slow`, meaning more than 3 minutes passed between the OTP page and the code. `relatedDumps` links the matching `otp-redisplay-*.json`.

On a residential machine, login may optionally warm those defense cookies via **Playwright** (Chrome channel when available) before the Node CAPTCHA/OTP chain, then merges `Domain=.clalit.co.il` cookies into the tough-cookie jar with `loose` parsing. Playwright is a **devDependency** only (`npm install` in this repo). Login works without it; when Playwright is missing, the warm step is skipped.


## Idle TTL

Portal session TTL was **not measured** in live validation. Default soft idle hint: **~30 minutes**. Longer idle → expect `REAUTHENTICATION_REQUIRED` and run `login` again.

## Keep-alive

`GET /OnlineWeb/ServicesForAll/RefreshSession.aspx` was observed returning small HTML. Optional CLI: `clalit-mcp refresh-session`. Use sparingly; it does not replace login and must not be used to probe Imperva.

## Owner scope

The portal HTML may include family slider fields (`FamilySliderControl21$au` / `$cu`). The client **never** posts a member switch. Detail refs must come from the owner's own `LabsTestList.aspx` links only.

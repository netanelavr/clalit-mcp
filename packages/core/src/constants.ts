/** Observed Clalit e-services origin (Gate 2 HAR). */
export const PORTAL_ORIGIN = "https://e-services.clalit.co.il";

/** Hosts this client may contact. Never widen without evidence. */
export const ALLOWED_ORIGINS = new Set([
  PORTAL_ORIGIN,
  "https://accessibility.clalit.co.il",
]);

/** Auth paths (ASP.NET WebForms). Captcha + SMS OTP; never bypass Imperva. */
export const PATHS = {
  loginFoot: "/onlineweb/general/infootplogin.aspx",
  otpSms: "/OnlineWeb/General/OTPSMSVerification.aspx",
  login: "/OnlineWeb/General/Login.aspx",
  labsList: "/OnlineWeb/Services/Labs/LabsTestList.aspx",
  labDetail: "/OnlineWeb/Services/Labs/LabTestDetails.aspx",
  refreshSession: "/OnlineWeb/ServicesForAll/RefreshSession.aspx",
} as const;

/** WebForms field names observed for labs list date filter. */
export const LABS_LIST_FIELDS = {
  fromDate: "ctl00$ctl00$cphBody$bodyContent$LabsHistory1$datepickerRangeCalendar$txtFromDate",
  toDate: "ctl00$ctl00$cphBody$bodyContent$LabsHistory1$datepickerRangeCalendar$txtToDate",
  grid: "LabsHistory1$gvTestListInDateRange",
} as const;

/** Lab detail opaque query param names (values from list links only). */
export const LAB_DETAIL_PARAMS = ["s", "d", "ls"] as const;

/** Default soft idle TTL: 30 minutes. Longer idle → expect re-login. */
export const DEFAULT_IDLE_TTL_MS = 30 * 60_000;

/** Conservative rate: space portal GETs. Do not hammer Imperva-fronted hosts. */
export const MIN_REQUEST_GAP_MS = 750;

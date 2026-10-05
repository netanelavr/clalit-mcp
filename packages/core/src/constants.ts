/** Observed Clalit e-services origin (redacted endpoint map). */
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
  prescriptionsList: "/OnlineWeb/Services/Medicine/PatientPrescriptionsex.aspx",
  prescriptionIssueStatus: "/onlineweb/api/PatientPrescriptions/IssueDrugsByPatientReceiptId",
  labOrdersList: "/OnlineWeb/Services/LabOrders/LabOrderList.aspx",
  labOrderDetail: "/OnlineWeb/Services/LabOrders/LabOrderDetails.aspx",
  refreshSession: "/OnlineWeb/ServicesForAll/RefreshSession.aspx",
} as const;

/** WebForms field names for labs list date filter + pager. */
export const LABS_LIST_FIELDS = {
  fromDate: "ctl00$ctl00$cphBody$bodyContent$LabsHistory1$datepickerRangeCalendar$txtFromDate",
  toDate: "ctl00$ctl00$cphBody$bodyContent$LabsHistory1$datepickerRangeCalendar$txtToDate",
  /** Apply date range — required; filling from/to alone does not reload the grid. */
  filterSubmit: "ctl00$ctl00$cphBody$bodyContent$LabsHistory1$btnGetTestsAcc$lnkSubButton",
  /** ASP.NET pager control id prefix; page N is `${pagerLinkPrefix}${N}`. */
  pagerLinkPrefix:
    "ctl00$ctl00$cphBody$bodyContent$LabsHistory1$gvTestListInDateRange$PagerLink-",
  grid: "LabsHistory1$gvTestListInDateRange",
} as const;

/** Portal datepicker format on LabsTestList (dots, not slashes). */
export const LABS_DATE_FORMAT_HINT = "dd.MM.yyyy";

/** Safety cap for labs list pager walks. */
export const LABS_LIST_MAX_PAGES = 40;


/** WebForms field names for prescriptions list date/filter + pager. */
export const PRESCRIPTIONS_LIST_FIELDS = {
  fromDate: "ctl00$ctl00$cphBody$bodyContent$dateRange$txtFromDate",
  toDate: "ctl00$ctl00$cphBody$bodyContent$dateRange$txtToDate",
  includeExpired: "ctl00$ctl00$cphBody$bodyContent$chkIncludeExpiredPrescriptions",
  sectionId: "ctl00$ctl00$cphBody$bodyContent$hdnSectionID",
  /** ASP.NET pager control; page N is posted as __EVENTARGUMENT with this __EVENTTARGET. */
  gridPager: "ctl00$ctl00$cphBody$bodyContent$gridPager",
  hiddenPager: "ctl00$ctl00$cphBody$bodyContent$gridPager$hiddenPager",
} as const;

/** Safety cap for prescriptions list pager walks. */
export const PRESCRIPTIONS_LIST_MAX_PAGES = 40;

/** Lab detail opaque query param names (values from list links only). */
export const LAB_DETAIL_PARAMS = ["s", "d", "ls"] as const;

/** Lab-order detail opaque query param name (value from list lnkOrderDetails only). */
export const LAB_ORDER_DETAIL_PARAMS = ["ord"] as const;

/** Default soft idle TTL: 30 minutes. Longer idle → expect re-login. */
export const DEFAULT_IDLE_TTL_MS = 30 * 60_000;

/** Conservative rate: space portal GETs. Do not hammer Imperva-fronted hosts. */
export const MIN_REQUEST_GAP_MS = 750;

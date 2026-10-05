/** Opaque detail coordinates from LabOrderList link query `ord` only. */
export interface LabOrderRef {
  ord: string;
}

/** One row from LabOrderList.aspx (own list only). */
export interface LabOrderListItem {
  ref: LabOrderRef;
  issuanceDate?: string;
  referer?: string;
  validTo?: string;
  section?: string;
  /** Whether a detail link (lnkOrderDetails) with ord was present. */
  hasDetail: boolean;
}

/** One item row from LabOrderDetails.aspx gvLabOrdersItem. */
export interface LabOrderItem {
  section?: string;
  testName?: string;
}

/** Parsed LabOrderDetails.aspx page. */
export interface LabOrderDetail {
  ref: LabOrderRef;
  title?: string;
  validFrom?: string;
  validTo?: string;
  items: LabOrderItem[];
  /** Opaque portal hdnLabOrderID when present. */
  labOrderId?: string;
}

export type Segment = "all" | "recent_purchase" | "stale_cart";

export type CampaignStatus = "scheduled" | "sending" | "sent";

export interface CustomerFacts {
  customerId: string;
  lastPurchaseAt: number | null;
  cartNonempty: boolean;
  cartUpdatedAt: number | null;
}

export interface Campaign {
  id: string;
  title: string;
  body: string;
  segment: Segment;
  scheduledAt: number;
  status: CampaignStatus;
  sendStartedAt: number | null;
  expiresAt: number | null;
}

export interface Notification {
  id: number;
  campaignId: string;
  customerId: string;
  title: string;
  body: string;
  createdAt: number;
  expiresAt: number;
}

export interface AdvanceResult {
  campaignId: string;
  status: CampaignStatus;
  deliveredThisRound: number;
  expiredThisRound: number;
  purgedThisRound: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_PURCHASE_WINDOW_MS = 30 * DAY_MS;
export const STALE_CART_THRESHOLD_MS = 48 * 60 * 60 * 1000;
export const NOTIFICATION_TTL_MS = 30 * DAY_MS;

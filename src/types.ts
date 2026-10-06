export type Segment = 'all' | 'recent_buyers' | 'stale_cart';

export type CampaignStatus = 'scheduled' | 'sending' | 'sent';

export interface CustomerState {
  customerId: string;
  lastPurchaseAt: number | null;
  cartNonEmpty: boolean;
  cartUpdatedAt: number | null;
}

export interface Campaign {
  id: string;
  title: string;
  body: string;
  segment: Segment;
  scheduledAt: number;
  status: CampaignStatus;
  activatedAt: number | null;
  expiresAt: number | null;
}

export interface Notification {
  id: string;
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
  delivered: number;
  expiredNotifications: number;
  expiredRecipients: number;
}

export interface CreateCampaignInput {
  id: string;
  title: string;
  body: string;
  segment: Segment;
  scheduledAt: number;
}

export interface OrderParams {
  url: string;
  bundleLabel: string;
  paymentMethod: string;
  fields: Record<string, string>;
  /** Source-keyed customer inputs (account_id / userid / zoneid) for the API path's recipientExtraInfo. */
  validationData?: Record<string, string>;
}

export interface ContactDetails {
  firstName: string;
  surname: string;
  email: string;
  phone: string;
}

export interface WalletAutomation {
  walletPin?: string;
  otpReceiverUrl?: string;
  otpReceiverToken?: string;
  otpTimeoutMs: number;
  merchantName: string;
  paymentSmsTimeoutMs: number;
}

export interface BotConfig {
  headless: boolean;
  proxy?: string;
  stopBeforeBuy: boolean;
  stopBeforePay: boolean;
  stopAfterPay: boolean;
}

export interface FullConfig extends OrderParams, ContactDetails, BotConfig, WalletAutomation {}

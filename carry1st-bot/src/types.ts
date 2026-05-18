export interface OrderParams {
  playerId: string;
  bundleLabel: string;
  countryCode: string;
  paymentMethod: string;
  firstName: string;
  surname: string;
  email: string;
  phone: string;
  dialCode: string;
}

export interface BotConfig {
  headless: boolean;
  proxy?: string;
}

export interface FullConfig extends OrderParams, BotConfig {}

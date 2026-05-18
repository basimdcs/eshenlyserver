import { Command } from 'commander';
import dotenv from 'dotenv';

dotenv.config();

export type PaymentMethod = 'ewallet' | 'credit' | 'fawry' | 'carrier';

export interface PurchaseConfig {
  playerId: string;
  sku: number;
  phone: string;
  email: string;
  paymentMethod: PaymentMethod;
  headless: boolean;
  dryRun: boolean;
  timeout: number;
}

export function parseArgs(): PurchaseConfig {
  const program = new Command();

  program
    .requiredOption('--player-id <id>', 'PUBG Mobile Player ID', process.env.PLAYER_ID)
    .requiredOption('--sku <amount>', 'UC amount to purchase (e.g., 60)', process.env.SKU)
    .option('--phone <number>', 'Payment phone number', process.env.PHONE || '01200663741')
    .option('--email <address>', 'Payment email address', process.env.EMAIL || 'covermytunes@gmail.com')
    .option('--payment-method <method>', 'Payment method: ewallet|credit|fawry|carrier', process.env.PAYMENT_METHOD || 'ewallet')
    .option('--headless', 'Run in headless mode', process.env.HEADLESS === 'true')
    .option('--dry-run', 'Stop before actual payment (phase 6)', process.env.DRY_RUN === 'true')
    .option('--timeout <ms>', 'Timeout per action in ms', process.env.TIMEOUT || '30000');

  program.parse();
  const opts = program.opts();

  return {
    playerId: opts.playerId,
    sku: parseInt(opts.sku, 10),
    phone: opts.phone,
    email: opts.email,
    paymentMethod: opts.paymentMethod as PaymentMethod,
    headless: opts.headless ?? false,
    dryRun: opts.dryRun ?? false,
    timeout: parseInt(opts.timeout, 10),
  };
}

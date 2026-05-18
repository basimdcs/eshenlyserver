import "dotenv/config";
import type { BotConfig, FullConfig } from "./types.js";

function printUsage() {
  console.log(`Usage: npx tsx src/index.ts <playerId> <bundleLabel> <paymentMethod> <firstName> <surname> <email> <phone> [dialCode] [countryCode]

Arguments:
  playerId       PUBG Mobile Player ID
  bundleLabel    Bundle label (e.g. "600 + 60 UC")
  paymentMethod  Payment method (e.g. "Orange Cash")
  firstName      First name
  surname        Surname
  email          Email address
  phone          Phone number
  dialCode       Dial code (default: 20)
  countryCode    Country code (default: EG)

Environment variables (.env):
  HEADLESS       true/false (default: true)
  PROXY          Proxy URL (e.g. http://user:pass@host:port)

Example:
  npx tsx src/index.ts 5292716602 "600 + 60 UC" "Orange Cash" Basim Basim basimdcs@hotmail.com 01200663741`);
}

export function loadConfig(): FullConfig {
  const args = process.argv.slice(2);

  if (args.length < 7) {
    printUsage();
    process.exit(1);
  }

  const [playerId, bundleLabel, paymentMethod, firstName, surname, email, phone] = args;
  const dialCode = args[7] || "20";
  const countryCode = args[8] || "EG";

  const botConfig: BotConfig = {
    headless: process.env.HEADLESS !== "false",
    proxy: process.env.PROXY,
  };

  return {
    playerId,
    bundleLabel,
    paymentMethod,
    firstName,
    surname,
    email,
    phone,
    dialCode,
    countryCode,
    ...botConfig,
  };
}

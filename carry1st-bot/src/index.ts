import { loadConfig } from "./config.js";
import { Carry1stBot } from "./bot.js";

async function main() {
  console.log("=== Carry1st PUBG UC Top-Up Bot ===\n");

  const config = loadConfig();

  console.log(`Player ID:  ${config.playerId}`);
  console.log(`Bundle:     ${config.bundleLabel}`);
  console.log(`Country:    ${config.countryCode}`);
  console.log(`Payment:    ${config.paymentMethod}`);
  console.log(`Contact:    ${config.firstName} ${config.surname}`);
  console.log(`Email:      ${config.email}`);
  console.log(`Phone:      +${config.dialCode} ${config.phone}`);
  console.log(`Headless:   ${config.headless}`);
  if (config.proxy) console.log(`Proxy:      ${config.proxy}`);
  console.log();

  const bot = new Carry1stBot(config);
  await bot.run();
}

main().catch((err) => {
  console.error("\nBot failed:", err.message);
  process.exit(1);
});

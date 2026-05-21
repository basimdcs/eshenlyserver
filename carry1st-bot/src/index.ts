import { loadConfig } from "./config.js";
import { Carry1stBot } from "./bot.js";

async function main() {
  console.log("=== Carry1st Top-Up Bot ===\n");

  const config = loadConfig();

  console.log(`URL:        ${config.url}`);
  console.log(`Bundle:     ${config.bundleLabel}`);
  console.log(`Payment:    ${config.paymentMethod}`);
  console.log(
    `Fields:     ${
      Object.keys(config.fields).length === 0
        ? "(none)"
        : JSON.stringify(config.fields)
    }`
  );
  console.log(`Contact:    ${config.firstName} ${config.surname} <${config.email}> ${config.phone}`);
  console.log(`Headless:   ${config.headless}`);
  if (config.proxy) console.log(`Proxy:      ${config.proxy}`);
  if (config.stopBeforeBuy) console.log(`Mode:       STOP BEFORE BUY (no payment will be triggered)`);
  if (config.stopBeforePay) console.log(`Mode:       STOP BEFORE PAY (no OTP will be sent)`);
  if (config.stopAfterPay) console.log(`Mode:       STOP AFTER PAY (OTP WILL be sent to wallet phone)`);
  if (config.walletPin && !config.stopBeforeBuy && !config.stopBeforePay && !config.stopAfterPay) {
    console.log(`Wallet:     PIN configured (full automation enabled)`);
    console.log(`OTP recv:   ${config.otpReceiverUrl || "(not set — will stop after OTP)"}`);
  }
  console.log();

  const bot = new Carry1stBot(config);
  await bot.run();
}

main().catch((err) => {
  console.error("\nBot failed:", err.message);
  process.exit(1);
});

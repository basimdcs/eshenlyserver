export const SELECTORS = {
  // Phase 1: Page Load & Cleanup
  promoOverlay: 'div.activity-iframe-wrapper',
  buttonTextClass: '[class*="Button_text"]',

  // Phase 2: Player ID (Arabic + English placeholders)
  playerIdArea: '[class*="UserTabBox_login_text"]',
  playerIdTextbox: 'input[placeholder*="إدخال حساب معرف لاعب"], input[placeholder*="Player ID"], input[placeholder*="player"], [class*="SelectServerBox"] input',
  playerIdDialogOk: '[class*="SelectServerBox"] [class*="Button_text"]',
  playerNickname: '[class*="Eliah"], [class*="player-name"]',

  // Phase 3: SKU Selection (clicking opens checkout panel)
  skuCard: '[class*="RechargeClassCard_recharge_class_box"]',

  // Phase 4: Payment Method (inside checkout panel)
  checkoutPaymentItem: '[class*="ChannelPayList_payment_item"]',

  // Phase 5: Purchase
  payButton: '[class*="PayPriceDetailPc"] button',
  confirmDialog: '[class*="ReconfirmPaymentPop_pop_mode_box"]',
  confirmPayBtn: '[class*="ReconfirmPaymentPop_btn"]',

  // Phase 6: Payment Window
  paymentIframe: 'iframe[src*="pay.harvestsharp.com"], iframe[src*="payment"]',
  paymentPhone: 'input[name="phone"], input[type="tel"], input[placeholder*="phone"]',
  paymentEmail: 'input[name="email"], input[type="email"], input[placeholder*="email"]',
  saveInfoCheckbox: 'input[type="checkbox"]',
  paymentSubmitBtn: 'button[type="submit"], .pay-button, button:has-text("Pay")',
} as const;

/**
 * Paystack REST helpers (fetch-based; no hard dependency on SDK).
 */
const crypto = require('crypto');

const BASE = (process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/$/, '');
const SECRET = () => process.env.PAYSTACK_SECRET_KEY || '';
const PUBLIC = () => process.env.PAYSTACK_PUBLIC_KEY || '';

function isConfigured() {
  return !!(SECRET() && PUBLIC());
}

async function paystackRequest(method, path, body) {
  const key = SECRET();
  if (!key) throw new Error('PAYSTACK_SECRET_KEY not configured');
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    const msg = data.message || `Paystack ${res.status}`;
    const err = new Error(msg);
    err.paystack = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Initialize a transaction (amount in kobo). */
async function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata }) {
  const payload = {
    email,
    amount: Math.round(amountKobo),
    currency: 'NGN',
    reference,
    metadata: metadata || {},
  };
  if (callbackUrl) payload.callback_url = callbackUrl;
  const data = await paystackRequest('POST', '/transaction/initialize', payload);
  return data.data;
}

async function verifyTransaction(reference) {
  const data = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  return data.data;
}

/** Create a transfer recipient for later payouts to host bank. */
async function createTransferRecipient({ name, accountNumber, bankCode }) {
  const data = await paystackRequest('POST', '/transferrecipient', {
    type: 'nuban',
    name,
    account_number: String(accountNumber),
    bank_code: String(bankCode),
    currency: 'NGN',
  });
  return data.data;
}

async function resolveAccountNumber(accountNumber, bankCode) {
  const q = `account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`;
  const data = await paystackRequest('GET', `/bank/resolve?${q}`);
  return data.data;
}

async function listBanks() {
  const data = await paystackRequest('GET', '/bank?currency=NGN&country=nigeria');
  return data.data || [];
}

/** Transfer NGN (kobo) to a recipient_code. */
async function initiateTransfer({ amountKobo, recipientCode, reference, reason }) {
  const data = await paystackRequest('POST', '/transfer', {
    source: 'balance',
    amount: Math.round(amountKobo),
    recipient: recipientCode,
    reference,
    reason: reason || 'Meet payout',
  });
  return data.data;
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  const key = SECRET();
  if (!key || !signatureHeader) return false;
  const hash = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  return hash === signatureHeader;
}

function newReference(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  isConfigured,
  publicKey: PUBLIC,
  initializeTransaction,
  verifyTransaction,
  createTransferRecipient,
  resolveAccountNumber,
  listBanks,
  initiateTransfer,
  verifyWebhookSignature,
  newReference,
};

/**
 * NEAR кошелёк агента
 *
 * Создаёт implicit-аккаунт, пополняет через testnet faucet,
 * управляет депозитами в контракт.
 */

import { connect, keyStores, KeyPair, utils } from "near-api-js";
import { createLogger } from "../utils/logger.js";

const NEAR_YOCTO = BigInt("1000000000000000000000000");
const GAS = "30000000000000"; // 30 TGas

/**
 * Создать или загрузить кошелёк агента
 * @param {object} opts — { name, avatar, network, contractId, dataDir }
 * @returns {{ account, accountId, keyPair, getBalance, deposit, placeBet, ensureFunded }}
 */
export async function createWallet(opts) {
  const { name, avatar = "🤖", network = "testnet", contractId, dataDir = "data" } = opts;
  const log = createLogger(name, avatar);

  const keyStore = new keyStores.InMemoryKeyStore();
  const nodeUrl = network === "mainnet"
    ? "https://free.rpc.fastnear.com"
    : "https://test.rpc.fastnear.com";

  // Загружаем или генерируем ключ
  const fs = await import("fs");
  const path = await import("path");
  const keyFile = path.join(dataDir, `${name}.key.json`);

  let keyPair;
  let accountId;

  if (fs.existsSync(keyFile)) {
    const saved = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    keyPair = KeyPair.fromString(saved.privateKey);
    accountId = saved.accountId;
    log.info(`Загружен кошелёк: ${accountId}`);
  } else {
    // Создаём аккаунт через helper API (testnet)
    keyPair = KeyPair.fromRandom("ed25519");
    const publicKey = keyPair.getPublicKey().toString();

    if (network === "testnet") {
      // Генерируем имя: nearcast-agent-{name}-{random}.testnet
      const suffix = Math.random().toString(36).slice(2, 8);
      const desiredId = `nc-${name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${suffix}.testnet`;

      log.info(`Создаю аккаунт ${desiredId}...`);

      const res = await fetch("https://helper.testnet.near.org/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newAccountId: desiredId, newAccountPublicKey: publicKey }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Не удалось создать аккаунт: ${res.status} ${text.slice(0, 100)}`);
      }

      accountId = desiredId;
      log.info(`Аккаунт создан: ${accountId} (10 NEAR от faucet)`);
    } else {
      // Mainnet: implicit account
      accountId = Buffer.from(keyPair.getPublicKey().data).toString("hex");
      log.warn(`Mainnet implicit: ${accountId} — нужно пополнить вручную`);
    }

    // Сохраняем ключ
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyFile, JSON.stringify({
      accountId,
      publicKey: keyPair.getPublicKey().toString(),
      privateKey: keyPair.toString(),
      network,
    }, null, 2));
  }

  await keyStore.setKey(network, accountId, keyPair);
  const near = await connect({ networkId: network, keyStore, nodeUrl });
  const account = await near.account(accountId);

  // ── Методы ──────────────────────────────────────────────

  /** Баланс NEAR аккаунта */
  async function getNearBalance() {
    const state = await account.state();
    return Number(state.amount) / Number(NEAR_YOCTO);
  }

  /** Баланс на контракте (internal) */
  async function getContractBalance() {
    try {
      const bal = await account.viewFunction({
        contractId,
        methodName: "get_balance",
        args: { account_id: accountId },
      });
      return Number(bal) / Number(NEAR_YOCTO);
    } catch {
      return 0;
    }
  }

  /** Депозит NEAR в контракт */
  async function deposit(amountNear) {
    const yocto = BigInt(Math.ceil(amountNear)) * NEAR_YOCTO;
    log.action("deposit", `${amountNear} NEAR в контракт`);
    await account.functionCall({
      contractId,
      methodName: "deposit",
      args: {},
      gas: GAS,
      attachedDeposit: yocto.toString(),
    });
  }

  /** Разместить ставку */
  async function placeBet(marketId, outcome, amountNear) {
    const yocto = BigInt(Math.round(amountNear * 1e4)) * BigInt(1e20);
    log.action("bet", `${amountNear} NEAR на рынке #${marketId}, исход ${outcome}`);
    await account.functionCall({
      contractId,
      methodName: "place_bet",
      args: { market_id: marketId, outcome, amount: yocto.toString() },
      gas: GAS,
      attachedDeposit: "0",
    });
  }

  /** Пополнить до нужного баланса (создаёт temp-аккаунты через faucet) */
  async function ensureFunded(minNear = 5) {
    const bal = await getNearBalance();
    if (bal >= minNear) {
      log.info(`Баланс ${bal.toFixed(2)} NEAR — достаточно`);
      return;
    }

    log.warn(`Баланс ${bal.toFixed(2)} NEAR < ${minNear} — пополняю...`);

    // Создаём временный аккаунт и переводим с него
    const tmpKey = KeyPair.fromRandom("ed25519");
    const tmpPub = tmpKey.getPublicKey().toString();
    const tmpSuffix = Math.random().toString(36).slice(2, 8);
    const tmpId = `nc-tmp-${tmpSuffix}.testnet`;

    try {
      const res = await fetch("https://helper.testnet.near.org/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newAccountId: tmpId, newAccountPublicKey: tmpPub }),
      });

      if (!res.ok) {
        log.error(`Faucet недоступен: ${res.status}`);
        return;
      }

      // Переводим ~9.9 NEAR с temp на основной
      await keyStore.setKey(network, tmpId, tmpKey);
      const tmpAccount = await near.account(tmpId);
      const transferYocto = (BigInt(99) * NEAR_YOCTO) / BigInt(10); // 9.9 NEAR
      await tmpAccount.sendMoney(accountId, transferYocto.toString());

      const newBal = await getNearBalance();
      log.info(`Пополнено! Баланс: ${newBal.toFixed(2)} NEAR`);
    } catch (err) {
      log.error(`Ошибка пополнения: ${err.message}`);
    }
  }

  /** Обеспечить баланс на контракте */
  async function ensureContractBalance(minNear = 3) {
    const contractBal = await getContractBalance();
    if (contractBal >= minNear) return;

    const needed = Math.ceil(minNear - contractBal) + 1;
    const nearBal = await getNearBalance();

    if (nearBal < needed + 1) {
      await ensureFunded(needed + 5);
    }

    await deposit(needed);
  }

  return {
    account,
    accountId,
    keyPair,
    getNearBalance,
    getContractBalance,
    deposit,
    placeBet,
    ensureFunded,
    ensureContractBalance,
  };
}

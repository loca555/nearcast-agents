/**
 * NEAR кошелёк агента
 *
 * Создание аккаунта (приоритет):
 * 1. Загрузка сохранённого ключа (data/{name}.key.json)
 * 2. Faucet (helper.testnet.near.org) — если доступен
 * 3. Через FUNDER аккаунт (createAccount + перевод NEAR)
 *
 * FUNDER — любой аккаунт с NEAR (например oracle из NearCast).
 */

import { connect, keyStores, KeyPair } from "near-api-js";
import { createLogger } from "../utils/logger.js";

const NEAR_YOCTO = BigInt("1000000000000000000000000");
const GAS = "30000000000000"; // 30 TGas
const INITIAL_NEAR = BigInt(5) * NEAR_YOCTO; // 5 NEAR на новый аккаунт

/**
 * Создать или загрузить кошелёк агента
 */
export async function createWallet(opts) {
  const { name, avatar = "🤖", network = "testnet", contractId, dataDir = "data", funder } = opts;
  const log = createLogger(name, avatar);

  const keyStore = new keyStores.InMemoryKeyStore();
  const nodeUrl = network === "mainnet"
    ? "https://free.rpc.fastnear.com"
    : "https://test.rpc.fastnear.com";

  const fs = await import("fs");
  const path = await import("path");
  const keyFile = path.join(dataDir, `${name}.key.json`);

  let keyPair;
  let accountId;

  if (fs.existsSync(keyFile)) {
    // ── Загружаем существующий ключ ──
    const saved = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    keyPair = KeyPair.fromString(saved.privateKey);
    accountId = saved.accountId;
    log.info(`Загружен кошелёк: ${accountId}`);
  } else {
    // ── Создаём новый аккаунт ──
    keyPair = KeyPair.fromRandom("ed25519");
    const publicKey = keyPair.getPublicKey().toString();
    const suffix = Math.random().toString(36).slice(2, 8);
    let desiredId = `nc-${name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${suffix}.testnet`;

    if (network === "testnet") {
      // Попытка 1: faucet
      let created = false;
      try {
        log.info(`Создаю ${desiredId} через faucet...`);
        const res = await fetch("https://helper.testnet.near.org/account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newAccountId: desiredId, newAccountPublicKey: publicKey }),
        });
        if (res.ok) {
          created = true;
          log.info(`Аккаунт создан через faucet: ${desiredId} (10 NEAR)`);
        } else {
          log.warn(`Faucet недоступен (${res.status}), пробую через funder...`);
        }
      } catch (err) {
        log.warn(`Faucet ошибка: ${err.message}, пробую через funder...`);
      }

      // Попытка 2: implicit account + перевод от funder
      if (!created && funder) {
        // Implicit account = hex от public key, не требует createAccount
        const implicitId = Buffer.from(keyPair.getPublicKey().data).toString("hex");
        log.info(`Создаю implicit ${implicitId.slice(0, 12)}... + перевод от funder...`);

        const funderKey = KeyPair.fromString(funder.privateKey);
        await keyStore.setKey(network, funder.accountId, funderKey);
        const near = await connect({ networkId: network, keyStore, nodeUrl });
        const funderAccount = await near.account(funder.accountId);

        await funderAccount.sendMoney(implicitId, INITIAL_NEAR.toString());
        desiredId = implicitId; // используем implicit ID
        created = true;
        log.info(`Implicit аккаунт создан: ${implicitId.slice(0, 16)}... (5 NEAR)`);
      }

      if (!created) {
        throw new Error("Не удалось создать аккаунт: faucet и funder недоступны");
      }

      accountId = desiredId;
    } else {
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

  async function getNearBalance() {
    const state = await account.state();
    return Number(state.amount) / Number(NEAR_YOCTO);
  }

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

  /** Клейм выигрыша/рефанда (зачисляется на внутренний баланс контракта) */
  async function claimWinnings(marketId) {
    log.action("claim", `Клейм выигрыша на рынке #${marketId}`);
    await account.functionCall({
      contractId,
      methodName: "claim_winnings",
      args: { market_id: marketId },
      gas: GAS,
      attachedDeposit: "0",
    });
  }

  /** Пополнить через funder или faucet */
  async function ensureFunded(minNear = 5) {
    const bal = await getNearBalance();
    if (bal >= minNear) {
      log.info(`Баланс ${bal.toFixed(2)} NEAR — достаточно`);
      return;
    }

    log.warn(`Баланс ${bal.toFixed(2)} NEAR < ${minNear} — пополняю...`);

    // Через funder
    if (funder) {
      try {
        const funderKey = KeyPair.fromString(funder.privateKey);
        await keyStore.setKey(network, funder.accountId, funderKey);
        const funderAccount = await near.account(funder.accountId);
        const sendAmount = BigInt(Math.ceil(minNear - bal + 1)) * NEAR_YOCTO;
        await funderAccount.sendMoney(accountId, sendAmount.toString());
        const newBal = await getNearBalance();
        log.info(`Пополнено от funder! Баланс: ${newBal.toFixed(2)} NEAR`);
        return;
      } catch (err) {
        log.error(`Funder ошибка: ${err.message}`);
      }
    }

    // Через faucet (fallback)
    try {
      const tmpKey = KeyPair.fromRandom("ed25519");
      const tmpSuffix = Math.random().toString(36).slice(2, 8);
      const tmpId = `nc-tmp-${tmpSuffix}.testnet`;

      const res = await fetch("https://helper.testnet.near.org/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newAccountId: tmpId, newAccountPublicKey: tmpKey.getPublicKey().toString() }),
      });

      if (!res.ok) {
        log.error(`Faucet недоступен: ${res.status}`);
        return;
      }

      await keyStore.setKey(network, tmpId, tmpKey);
      const tmpAccount = await near.account(tmpId);
      const transferYocto = (BigInt(99) * NEAR_YOCTO) / BigInt(10);
      await tmpAccount.sendMoney(accountId, transferYocto.toString());

      const newBal = await getNearBalance();
      log.info(`Пополнено от faucet! Баланс: ${newBal.toFixed(2)} NEAR`);
    } catch (err) {
      log.error(`Ошибка пополнения: ${err.message}`);
    }
  }

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
    account, accountId, keyPair,
    getNearBalance, getContractBalance,
    deposit, placeBet, claimWinnings, ensureFunded, ensureContractBalance,
  };
}

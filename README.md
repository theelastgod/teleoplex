# Teleoplex

Launchpad for a same-block bundle. It generates the wallets.

```bash
npm start
```

Open http://127.0.0.1:8787. Sign in with Phantom, Solflare, Backpack, or an Ethereum wallet in the browser. A machine passphrase still opens the local vault. The server also listens on the LAN. Set `TELEOPLEX_HOST=127.0.0.1` to keep it on this machine only.

The coin is TELEOPLEX, ticker $TLPX. A mainnet Pump bundle takes 0.5% of the SOL spent. That SOL buys $TLPX and the tokens are burned. Until the mint is saved in Settings, the fee sits in the buyback wallet shown on the pad.

## What it does

- Pump.fun: create the coin and buy with your own wallets in one bundle. Mainnet sends that bundle through Jito. Devnet sends the same transactions one after another.
- Solana: mint a fixed Token-2022 supply, deliver it to your wallets, and remove mint authority in that same bundle.
- Robinhood Chain: Pons `launchAndBuy` (create plus the first buy in one transaction). Your other wallets are listed as launch-tax exemptions and buy in the transactions right after.
- Hyperliquid: HIP-1 spot deployment, one signed step at a time. The first step pays the Dutch auction. Later steps use the token index from that purchase.

A same-block Solana bundle holds five transactions: the dev wallet and four more. Teleoplex stops there. On the wallet step, Generate builds that many new wallets and slots them into the bundle. The first is the dev wallet.

## Keys

The first screen creates a vault. Public addresses live in `data/wallets.json`. Secrets stay inside `data/vault.json`, encrypted with your passphrase. The passphrase stays in the server process until you lock it. The browser keeps only a session token.

Default clusters are Solana devnet and Hyperliquid testnet. Mainnet asks you to type the ticker. Robinhood Chain is mainnet, so it asks every time.

## What a send includes

Pump and Robinhood buys set a minimum out from the quote and your slippage. A trade with a zero floor is refused. Funding transfers go straight from a wallet you pick to wallets you pick.

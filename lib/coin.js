const RULES = {
  pump: { name: 32, symbol: 10, symbolPattern: /^[A-Za-z0-9]{1,10}$/ },
  solana: { name: 32, symbol: 10, symbolPattern: /^[A-Za-z0-9]{1,10}$/ },
  robinhood: { name: 64, symbol: 16, symbolPattern: /^[A-Za-z0-9]{1,16}$/ },
  hyperliquid: { name: 64, symbol: 6, symbolPattern: /^[A-Z0-9]{1,6}$/ },
};

export function assertCoin(venue, coin) {
  const rules = RULES[venue];
  if (!rules) throw new Error("Pick a venue.");
  const name = String(coin?.name || "").trim();
  const symbol = String(coin?.symbol || "").trim();
  if (!name) throw new Error("The coin needs a name.");
  if (name.length > rules.name) throw new Error(`Name is longer than ${rules.name} characters.`);
  if (!rules.symbolPattern.test(symbol)) {
    throw new Error(
      venue === "hyperliquid"
        ? "Hyperliquid ticker is 1 to 6 letters or digits, uppercase."
        : `Ticker is 1 to ${rules.symbol} letters or digits.`,
    );
  }
  const description = String(coin?.description || "");
  if (description.length > 2048) throw new Error("Description is longer than 2048 characters.");
  return {
    name,
    symbol,
    description,
    twitter: String(coin?.twitter || "").trim(),
    telegram: String(coin?.telegram || "").trim(),
    website: String(coin?.website || "").trim(),
    imageBase64: coin?.imageBase64 || "",
    imageType: coin?.imageType || "",
  };
}

export function imageBytes(coin) {
  if (!coin.imageBase64) return null;
  const bytes = Buffer.from(coin.imageBase64, "base64");
  if (bytes.length === 0) return null;
  if (bytes.length > 1_500_000) throw new Error("Image is larger than 1.5 MB.");
  const type = coin.imageType || "image/png";
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new Error("Image needs to be PNG, JPEG, GIF, or WebP.");
  return { bytes, type, name: "logo" };
}


if (reserveError) {
  console.error("Wallet reservation error:", reserveError);

  return reply({
    success: false,
    code: "RESERVATION_FAILED",
    message:
      "Could not reserve your wallet funds. No provider order was sent. Please try again.",
  }, 500);
}

if (!reservation?.success) {
  const reservationMessage = String(reservation?.message || "").toLowerCase();

  const insufficientFunds =
    reservation?.code === "INSUFFICIENT_FUNDS" ||
    reservation?.status === "insufficient_funds" ||
    reservationMessage.includes("insufficient") ||
    reservationMessage.includes("not enough") ||
    reservationMessage.includes("low balance") ||
    reservationMessage.includes("insufficient balance");

  return reply({
    success: false,
    code: insufficientFunds
      ? "INSUFFICIENT_FUNDS"
      : "PURCHASE_NOT_RESERVED",
    message: insufficientFunds
      ? "Insufficient funds. Please fund your Sparkle wallet and try again."
      : reservation?.message || "Purchase could not be reserved. Please try again.",
    status: reservation?.status,
    duplicate: !!reservation?.duplicate,
  }, insufficientFunds ? 200 : 409);
}

'use strict';
// All money maths in the engine is done in integer paise. Never use floats for balances.

const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
const fromPaise = (paise) => Math.round(paise) / 100;

// Split `total` into n integer parts that add up exactly. Element i (1-based) is
// floor((total + n - i) / n): the first (total % n) parts get one extra paisa.
// Property: for a larger total every element is >= the same element of a smaller total,
// which guarantees interest_i = emi_i - principal_i never goes negative.
function evenSplit(total, n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(Math.floor((total + n - i) / n));
  return out;
}

module.exports = { toPaise, fromPaise, evenSplit };

const PALETTE = [
  { start: "#31748F", end: "#191724" },
  { start: "#9CCFD8", end: "#1F1D2E" },
  { start: "#C4A7E7", end: "#26233A" },
  { start: "#EBBCBA", end: "#191724" },
  { start: "#EB6F92", end: "#1F1D2E" },
  { start: "#F6C177", end: "#26233A" },
  { start: "#524F67", end: "#191724" },
  { start: "#403D52", end: "#1F1D2E" },
];

const stringToHash = (string_) => {
  let hash = 0;
  if (string_.length === 0) return hash;
  for (let index = 0; index < string_.length; index++) {
    const char = string_.codePointAt(index);
    hash = (hash << 5) - hash + char;
    hash = Math.trunc(hash);
  }
  return hash;
};

export const getDeterministicGradient = (string_) => {
  if (!string_) return PALETTE[0];
  const hash = stringToHash(string_);
  const index = Math.abs(hash) % PALETTE.length;
  return PALETTE[index];
};

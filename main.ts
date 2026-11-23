// Direct-threaded tiny stack VM: each program is decoded once into a flat
// array of [handler, operand] pairs; the run loop just calls each pair in
// turn. Semantics are the kit reference vm.mjs's, in its check order;
// byte 0x1f is undefined (0x1e SHRU -> 0x20 EQ).
import { mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const D = new Int32Array(256); let sp = 0;
const C = new Int32Array(64); let csp = 0;
const M = new Int32Array(256);
const out = new Uint8Array(65536); let olen = 0;
let input = new Uint8Array(0), inPos = 0, pc = 0, n = 0;

// Handlers: f(operand) returns an exit code, or undefined to go on.
const H = (f, p, q, i = 0) => (f.p = p, f.q = q, f.i = i, f);
const B = g => { const h = () => { const b = D[sp - 1], a = D[sp - 2]; sp -= 2; D[sp++] = g(a, b); }; return H(h, 2, 1); };
const U = g => { const h = () => { D[sp - 1] = g(D[sp - 1]); }; return H(h, 1, 1); };

const HALT = H(() => 0, 0, 0);
const PUSH8 = H(v => { D[sp++] = v; }, 0, 1, 1);
const PUSH32 = H(v => { D[sp++] = v; }, 0, 1, 4);
const POP = H(() => { sp--; }, 1, 0);
const DUP = H(() => { D[sp] = D[sp - 1]; sp++; }, 1, 2);
const SWAP = H(() => { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; }, 2, 2);
const OVER = H(() => { D[sp] = D[sp - 2]; sp++; }, 2, 3);
const ROT = H(() => { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; }, 3, 3);
const ADD = B((a, b) => (a + b) | 0);
const SUB = B((a, b) => (a - b) | 0);
const MUL = B(Math.imul);
const DIV = H(() => { const b = D[sp - 1], a = D[sp - 2]; if (b === 0) return 4; sp -= 2; D[sp++] = a === -2147483648 && b === -1 ? a : (a / b) | 0; }, 2, 1);
const MOD = H(() => { const b = D[sp - 1], a = D[sp - 2]; if (b === 0) return 4; sp -= 2; D[sp++] = b === -1 ? 0 : (a % b) | 0; }, 2, 1);
const DIVU = H(() => { const b = D[sp - 1], a = D[sp - 2]; if (b === 0) return 4; sp -= 2; D[sp++] = Math.floor((a >>> 0) / (b >>> 0)) | 0; }, 2, 1);
const MODU = H(() => { const b = D[sp - 1], a = D[sp - 2]; if (b === 0) return 4; sp -= 2; D[sp++] = (a >>> 0) % (b >>> 0) | 0; }, 2, 1);
const NEG = U(a => -a | 0);
const AND = B((a, b) => a & b);
const OR = B((a, b) => a | b);
const XOR = B((a, b) => a ^ b);
const NOT = U(a => ~a);
const SHL = B((a, b) => a << (b & 31));
const SHR = B((a, b) => a >> (b & 31));
const SHRU = B((a, b) => (a >>> (b & 31)) | 0);
const EQ = B((a, b) => a === b ? 1 : 0);
const LT = B((a, b) => a < b ? 1 : 0);
const LTU = B((a, b) => a >>> 0 < b >>> 0 ? 1 : 0);
const JMP = H(r => { pc += r; }, 0, 0, 2);
const JZ = H(r => { if (D[--sp] === 0) pc += r; }, 1, 0, 2);
const JNZ = H(r => { if (D[--sp] !== 0) pc += r; }, 1, 0, 2);
const CALL = H(t => { if (csp === 64) return 7; C[csp++] = pc; pc = t; }, 0, 0, 2);
const RET = H(() => { if (csp === 0) return 8; pc = C[--csp]; }, 0, 0);
const LOAD = H(() => { const a = D[sp - 1]; if (a < 0 || a > 255) return 6; D[sp - 1] = M[a]; }, 1, 1);
const STORE = H(() => { const a = D[sp - 1], v = D[sp - 2]; if (a < 0 || a > 255) return 6; sp -= 2; M[a] = v; }, 2, 0);
const PRINT = H(() => { const s = String(D[sp - 1]); if (olen + s.length > 65536) return 11; sp--; for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i); }, 1, 0);
const PUTC = H(() => { if (olen + 1 > 65536) return 11; out[olen++] = D[--sp] & 255; }, 1, 0);
const IN = H(() => { D[sp++] = inPos < input.length ? input[inPos++] : -1; }, 0, 1);
const EXIT = H(() => D[--sp] & 255, 1, 0);
const BADOP = () => 5, BADIMM = () => 9;

// Opcode byte -> handler, in opcode order. Any other byte is unknown.
const HH = [HALT, PUSH8, PUSH32, POP, DUP, SWAP, OVER, ROT, ADD, SUB, MUL, DIV, MOD, DIVU, MODU, NEG, AND, OR, XOR, NOT, SHL, SHR, SHRU, EQ, LT, LTU, JMP, JZ, JNZ, CALL, RET, LOAD, STORE, PRINT, PUTC, IN, EXIT];
const HB = [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33, 34, 48, 49, 50, 51, 52, 64, 65, 80, 81, 82, 83];
const T = {};
for (let i = 0; i < 37; i++) T[HB[i]] = HH[i];

// Decode once; a jump may land on any byte, so every byte is decoded
// as if an instruction started there.
function decode(prog) {
  const code = new Array(n);
  for (let p = 0; p < n; p++) {
    const f = T[prog[p]];
    if (!f) { code[p] = [BADOP]; continue; }
    const im = f.i;
    if (p + im >= n) { code[p] = [BADIMM]; continue; }
    let v = 0;
    if (im === 1) v = (prog[p + 1] << 24) >> 24;
    else if (im === 4) v = prog[p + 1] | (prog[p + 2] << 8) | (prog[p + 3] << 16) | (prog[p + 4] << 24);
    else if (im === 2) v = f === CALL ? prog[p + 1] | (prog[p + 2] << 8) : ((prog[p + 1] | (prog[p + 2] << 8)) << 16) >> 16;
    code[p] = [f, v];
  }
  return code;
}

function run(prog, inp) {
  n = prog.length; input = inp; inPos = 0; sp = 0; csp = 0; olen = 0; pc = 0;
  M.fill(0);
  const code = decode(prog);
  let s = 0;
  for (;;) {
    if (s === 1000000) return 10;
    if (pc < 0 || pc >= n) return 9;
    const e = code[pc], f = e[0];
    if (f === BADOP) return 5;
    if (f === BADIMM) return 9;
    s++;
    if (sp < f.p) return 2;
    if (sp - f.p + f.q > 256) return 3;
    pc = pc + 1 + f.i;
    const r = f(e[1]);
    if (r !== undefined) return r;
  }
}

const ch = (f, m) => { try { chmodSync(f, m); } catch {} };
for (const id of readdirSync(I).sort()) {
  const prog = readFileSync(join(I, id, 'program.bin'));
  const inp = readFileSync(join(I, id, 'input.bin'));
  const exit = run(prog, inp);
  const dir = join(O, id);
  mkdirSync(dir, { recursive: true });
  const sf = join(dir, 'stdout.bin'), ef = join(dir, 'exit.txt');
  writeFileSync(sf, out.subarray(0, olen));
  writeFileSync(ef, String(exit) + '\n');
  // Only files this process just created, guarded; never /output itself.
  ch(dir, 0o755); ch(sf, 0o644); ch(ef, 0o644);
}

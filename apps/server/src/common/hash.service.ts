// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/hash.service.ts
//
// argon2id password/PIN hashing via hash-wasm (pure WASM, MIT-licensed, no
// node-gyp — task spec). Used for both the user password (login) and the
// restricted-content PIN (PUT /users/me/restricted, POST /restricted/unlock)
// — same algorithm, same cost parameters, so `hash()` output here is
// interoperable with packages/db/seed/seed.mjs's PRECOMPUTED seed hashes
// (verified directly in hash.service.spec.ts).

import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { argon2Verify, argon2id } from "hash-wasm";

/** Matches packages/db/seed/seed.mjs's header comment: the seed hashes were
 *  generated offline with these exact argon2id cost params. Using the same
 *  params here keeps every hash this service produces cross-verifiable
 *  with the seed data and with itself. */
const ARGON2ID_ITERATIONS = 2;
const ARGON2ID_PARALLELISM = 1;
const ARGON2ID_MEMORY_KIB = 19_456;
const ARGON2ID_HASH_LENGTH = 32;
const ARGON2ID_SALT_LENGTH = 16;

@Injectable()
export class HashService {
  /** Hashes a password or PIN into a PHC-encoded argon2id string suitable
   *  for storage in users.password_hash / user_settings.restricted_pin_hash. */
  async hash(plaintext: string): Promise<string> {
    const salt = randomBytes(ARGON2ID_SALT_LENGTH);
    return argon2id({
      password: plaintext,
      salt,
      iterations: ARGON2ID_ITERATIONS,
      parallelism: ARGON2ID_PARALLELISM,
      memorySize: ARGON2ID_MEMORY_KIB,
      hashLength: ARGON2ID_HASH_LENGTH,
      outputType: "encoded",
    });
  }

  /** Verifies `plaintext` against a PHC-encoded argon2id hash (cost params
   *  are read from the hash string itself, so this works for any
   *  argon2id-encoded hash regardless of which params produced it —
   *  including the seed's offline-generated hashes). */
  async verify(encodedHash: string, plaintext: string): Promise<boolean> {
    return argon2Verify({ hash: encodedHash, password: plaintext });
  }
}

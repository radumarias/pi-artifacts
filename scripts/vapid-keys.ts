// A new VAPID key pair for Web Push, as the two secrets the Worker reads: `node --experimental-strip-types
// scripts/vapid-keys.ts` prints them as JSON. Keep the private key secret (`cf secret put` or the environment); the
// public key is the application server key browsers subscribe with. A new pair ends every existing subscription.

import { generateVapidKeys } from "../worker/push/web-push.ts";

const { publicKey, privateKey } = await generateVapidKeys();
console.log(JSON.stringify({ PUSH_VAPID_PUBLIC_KEY: publicKey, PUSH_VAPID_PRIVATE_KEY: privateKey }, null, 2));

// use this script to delete hyperjump objects from the relay

// I should delete all hyperjumps before timestamp 1717299664 

import dotenv from 'dotenv';
import { getPublicKey, getEventHash, getSignature, SimplePool } from 'nostr-tools';
import type { Event, UnsignedEvent } from 'nostr-tools';
import WebSocket from 'ws';

if (!global.WebSocket) {
  global.WebSocket = WebSocket as any
}

dotenv.config();

function deleteEvent(event: Event) {
  console.log('deleting', event.id)
  const pubkey = getPublicKey(process.env.PRIVATE_KEY as string)
  const deletion = {
    kind: 5,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["e", event.id],
    ],
    content: `Deleting test hyperjump`,
  } as UnsignedEvent;
  const id = getEventHash(deletion);
  const signedEvent = { ...deletion, id } as Event;
  const sig = getSignature(deletion, process.env.PRIVATE_KEY as string);
  signedEvent.sig = sig
  pool.publish([relayUrl], signedEvent)
}

const relayUrl = 'wss://cyberspace.nostr1.com';

const pool = new SimplePool();

const oldHyperjumps = pool.sub([relayUrl], [{kinds: [321]}]);

oldHyperjumps.on('event', deleteEvent)

oldHyperjumps.on('eose', () => {
  console.log('deletion complete!')
})

// when I ran this, this was the output:
// deleting 9a812861bb53adf2821f9389419122218bc3c6f4b0933b13a4a45530d697af11
// deleting 37fd8f694f93e6e32caff780716c109b2cdccebac5232ffccc3e5b4f7094908a
// deleting be8f5587aebc0fe154d9ffdfb6d6280a80eff8ca32afbc3aef1f1f0ffffa4c3c
// deleting f6fd1f3647e7f7bc687c954616ced7ad7fa2c9e37b92fefe84e8cb9d2bb25aad
// deleting c71de32c212bfb2f3ca1386861585f75a24e34067a7fbccf5e523023d74ad49f
// deleting bf0bbc582ea0b1611c667698f619b0cd318c444449cb320ed7f5abc2108ad20e
// deleting 43aeb6a65b06583db246d5378bb3f425482c7eedbacc86d3d779c9cd6b9d6a9f
// deleting b17df5d76c5a74b79d1e73a8d5dbf0164c635991de32e9b48ea6850a85563562
// deleting fee6431a0b10588da2b8ef70b7155358e531b22c5ca759ab53dd1fb157b9af0d
// deleting 6c557b8d5723be8dca333f2873569780bfcf63e4ac84264c3601021722ffedc8
// deleting e977a36f5b0dc8886615cf9906ccb72d33c995a0801941c65be5c14273d58baa
// deleting 9ea5b187305d3c5babe571f8aff1b808476fcd282984c44da3f923b7943eeaeb
// deleting 6d192c72089b48429d0d50b9693d96ce870ff2e4810a1d72e9f7e8917f985c56
// deleting e225eaeacd709292c24845be5516eac60da95fe1db9641954f1e630aefa94e20
// deleting 9833c61107d1ebedef87971750e425bc0eeb9c5afe1fec187df1254dfec33f24
// deleting 5fd64f26b72545640cc16d93f34480344bc72429dd0eff7c53310730e7cf0810
// deleting fb73d9a4f18946c06c74606a4df5f647440d1fd131af76fea43774d99b70916d
// deleting bb2f0e2ca193bd74d5223f9fb291a142be97ead42758f05728451d5ba7d31763
// deleting 8598b06125ada88ac8fb4dd2b7ebf2fb30a3ef504d07ebcb21f821e62390a46d
// deleting a0d4cd598bd4d67b940a11df8a11fa2b5990315e4772be7e6d3c02d38835c5dc
// deleting 464d0f224e3c2edc9ae9244cdb277411b01542ecda71b52942177a000875482d
// deleting a232660056e33ba9d5a02c3c473ee3c0f5f935e7509e0e3d8527b2a70a4c3941
// deleting 1da2560fbf6685b68537870a49f69f9830fef84770027f7be9146ef90936a20e
// deleting 8741539fb1b4e8fd714d8d7ee76faee6f199823194424624b9e9cff0e7632037
// deleting 82f9c66b11f167e38d53f84a1f4e1e1868dff30bb48bda7e6f17d6f4ab4d3ef4
// deleting 070f2c5c04a2a8947e0e421655b4abd1fec5295c14c87dc5e9ed28e346443ce3
// deleting 988cefd3592d349edbd8294da8a1782f7f3ed72bdf5abd9f117bea80abda8fe5
// deleting 3cc1f18db8f0338b744a800b78222c16d047647671947d6bcea7ed45e0a9545d
// deleting 0f3bd1a47ad2e203d6b3b9df004becd79bd0b478493684454eb60b0fa1d214de
// deleting 18281af4224bf53baabbe5005b9281efdd9b5791d2a32265687a3052ba8d6fdc
// deleting 28d27646325cb77c6eb8b3dc1d2083a3dce80dcddbf2aa75b5537948571c01f6
// deleting a17df2847e1ba375b2caabae6875cccabaafb71c33add92cf02edcb84fd2e02f
// deleting 8c0d91ff87f175bf624e53deffbdebb67062dd2b0a055f9dd188d1cff49ed1d0
// deleting beb9c2127ea0b436895a8dd373e81f2cc412d0033eab4a06d7ba76b0dac91c89
// deleting 8796d09e3fc8fb8c0275cf61d06bd0f0fa8a1190886e7961dbf9da0c83252c37
// deleting cff544ce67fc7cd511dd6280f33813900abea24366017f976af7682375e6ccb2
// deleting 78e3fad933bbba82853e614287ee71de4d0db4bacf4678c0e8aaccfc401844fa
// deleting 671a3a1cb2b3f8b363fe527661cc0ebf7453fb92072dfe862bdd8742f92344b6
// deleting 1204a7913dfd1b799e1093fa5019342f1289af86b39e79ea75def1dbcafe06f1
// deletion complete!
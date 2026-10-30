# Firebase CLI Emulator Bug Reproduction: Storage Events Incorrectly Routed to Firestore Handler

**Bug Summary**: Firebase CLI emulator (`firebase-tools`) sometimes incorrectly routes Storage `onObjectFinalized` events to Firestore trigger handlers, causing `createBeforeSnapshot` to be called with Storage event data, leading to "Cannot determine payload type" errors and function crashes.

## 🐛 The Issue

When running Firebase Functions locally with `--inspect-functions`, Storage events occasionally get misrouted to Firestore event handlers. This manifests as:

1. **Storage events appear in Firestore's `createBeforeSnapshot` function**
2. **Error**: `Cannot determine payload type, datacontenttype is [storage-content-type]`
3. **Function crash**: Storage triggers fail because they're processed as Firestore events

### Expected Behavior

Storage `onObjectFinalized` events should only go to Storage trigger handlers, never to Firestore's `createBeforeSnapshot`.

### Actual Behavior

Under certain concurrency conditions, Storage events are incorrectly routed through Firestore code paths.

## 🔬 How to Reproduce

### Prerequisites

- Node.js 20+
- Firebase CLI installed (`npm install -g firebase-tools`)
- FFmpeg installed (for realistic CPU load - optional but recommended)

### Setup

1. **Clone this reproduction case**
2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Add debug logging** to Firebase Functions module:

   Add this line at the **start** of `createBeforeSnapshot` function in:
   `node_modules/firebase-functions/lib/v2/providers/firestore.js` around **line 186**:

   ```js
   console.log("create before snapshot: ", event);
   ```

   Optionally, add debug to the error case around **line 193**:

   ```js
   logger.error(
     `Cannot determine payload type, datacontenttype is ${event.datacontenttype}, failing out.`
   );
   ```

### Reproduction Steps

1. **Start the emulator** (Terminal 1):

   ```bash
   npm run serve
   ```

   (you may need to click play on the debugger in vscode to debug API, do this after emulators are fully running)

2. **Run the race condition test** (Terminal 2):

   ```bash
   ./test-race-conditions.sh
   ```

   This runs 100 iterations to trigger the race condition (much higher success rate with axiosist pattern).

3. **Watch for the bug**: Check Terminal 1 logs for:
   - Storage events appearing in `createBeforeSnapshot` logs
   - Events with `type: 'google.cloud.storage.object.v1.finalized'` in Firestore handler
   - Error: `Cannot determine payload type, datacontenttype is [something other than application/json]`

## 🎯 What Makes This Bug Occur

The bug is a **race condition** that happens when:

1. **Axiosist routing within same function**: Creates Express app inside trigger function instance
2. **In-memory HTTP requests**: Routes through axiosist mock adapter during trigger execution  
3. **Complex timing windows**: FFmpeg processing + axiosist routing creates context mixing
4. **Same Node.js process**: All triggers run in single process with `--inspect-functions`
5. **Event context pollution**: Emulator's event dispatcher gets confused during axiosist routing

## 📁 Project Structure

```
onobjectfinalize-indirect/
├── README.md                    # This file
├── firebase.json               # Emulator config with --inspect-functions
├── package.json                # Build and test scripts
├── test-race-conditions.sh     # Script to trigger the race condition
├── functions/
│   ├── src/
│   │   ├── index.ts            # Function exports
│   │   ├── firestore-triggers.ts  # Firestore triggers that create Storage events
│   │   └── storage-triggers.ts    # Storage triggers that should NOT see Firestore events
│   └── scripts/
│       └── createDoc.ts        # Helper to trigger the flow
└── tsconfig.json               # TypeScript configuration
```

## 🔧 Key Files

### Firestore Trigger (Creates Race Condition via Axiosist)

```typescript
// Main trigger that creates axiosist routing within same function instance
export const onUploadUpdate = onDocumentUpdated(
  "uploads/{uploadId}",
  async (event) => {
    // Kicks off triggerClipPreviewVideo calls via axiosist
    const clipPromises = [];
    const clipsToProcess = ['clip-1', 'clip-2', 'clip-3'];
    
    for (const clipId of clipsToProcess) {
      clipPromises.push(
        makeApiRequestWithFFmpeg({
          url: "/triggerClipPreviewVideo",
          data: { uploadId, clipId }
        })
      );
    }
  }
);

// Creates Express app within same function instance (key to race condition)
async function makeApiRequestWithFFmpeg(opts) {
  const { createAdapter } = await import('axiosist');
  const express = await import('express');
  const app = express();
  
  // Routes to generateAllClipPreviewsAndStitch within same function!
  app.post('/generateAllClipPreviewsAndStitch', async (req, res) => {
    const result = await triggerGenerateClipPreview(req.body);
    res.json(result);
  });
  
  const axiosInstance = axios.create({ adapter: createAdapter(app) });
  return await axiosInstance.post(opts.url, opts.data);
}
```

### Storage Trigger (Should NOT Hit Firestore Code)

```typescript
// This should NEVER call Firestore's createBeforeSnapshot
export const onUploadFileFinalize = onObjectFinalized(async (event) => {
  // BUG: Sometimes this event goes to createBeforeSnapshot instead!
  console.log("Storage event type:", event.type); // Should be storage, not firestore
});
```

## 🕐 Timing Notes

- **Bug frequency**: Much more frequent now - happens ~80% of the time with axiosist pattern
- **Race condition**: Triggered by axiosist routing within same function instance
- **Timing window**: Bug occurs when Express app routing creates context mixing
- **Key trigger**: In-memory HTTP requests via axiosist mock adapter during trigger execution

## 💡 Root Cause Analysis

The Firebase CLI emulator's event routing system has a race condition when:

1. **Axiosist mock adapter** creates Express app within trigger function instance
2. **In-memory HTTP routing** during trigger execution confuses event context
3. **Context mixing** between axiosist routing and Firebase event handling
4. **Event dispatcher pollution** when HTTP requests route through same Node.js process as triggers

## 🏃 Quick Test

For a fast reproduction without reading all details:

```bash
npm install
npm run serve &
sleep 10
./test-race-conditions.sh
```

Watch the logs for Storage events appearing in `createBeforeSnapshot`.

---

## 🆘 Impact

This bug causes **production Firebase Functions to crash** when:

- **Axiosist mock adapters** are used for HTTP routing in local development
- **Express apps** are created within trigger function instances  
- **In-memory HTTP requests** route through same Node.js process as triggers
- **Debug mode** (`--inspect-functions`) enables complex timing windows

**Real-world scenario**: This happens when HTTP routing interceptors create mock adapters for local development testing, causing event context pollution.

**Workaround**: Avoid axiosist mock adapters with `--inspect-functions`, but this breaks local development patterns.

## 📝 Environment

- **Firebase CLI**: Latest (tested with multiple versions)
- **Node.js**: 20.x
- **OS**: macOS/Linux
- **Functions Runtime**: nodejs20
- **Firebase Functions**: 6.4.0


## License

Source-available under [Ethan Source-Available No-Sale Terms 1.0](LICENSE). You can use and modify the covered code, including internally at work, and share it without charge. Selling the software, modified versions, paid access, or bundles requires a separate commercial license. Earlier licenses and third-party rights remain in force. See [scope and release policy](LICENSING.md).

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
   console.log("create before snapshot: ", event)
   ```
   
   Optionally, add debug to the error case around **line 193**:
   ```js
   logger.error(`Cannot determine payload type, datacontenttype is ${event.datacontenttype}, failing out.`);
   ```

### Reproduction Steps

1. **Start the emulator** (Terminal 1):
   ```bash
   npm run serve
   ```

2. **Run the race condition test** (Terminal 2):
   ```bash
   ./test-race-conditions.sh
   ```

3. **Watch for the bug**: Check Terminal 1 logs for:
   - Storage events appearing in `createBeforeSnapshot` logs
   - Events with `type: 'google.cloud.storage.object.v1.finalized'` in Firestore handler
   - Error: `Cannot determine payload type, datacontenttype is [something other than application/json]`

## 🎯 What Makes This Bug Occur

The bug is a **race condition** that happens when:

1. **High concurrency**: Multiple trigger types (Firestore + Storage) execute simultaneously
2. **Complex processing**: CPU-intensive operations (FFmpeg encoding) create timing windows
3. **Same Node.js process**: All triggers run in single process with `--inspect-functions`
4. **Event queue confusion**: Emulator's event dispatcher gets confused during specific timing windows

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

### Firestore Trigger (Creates Storage Events)
```typescript
// Creates Storage events through CPU-intensive FFmpeg processing
export const onUploadUpdate = onDocumentUpdated('uploads/{uploadId}', async (event) => {
  // CPU-intensive FFmpeg processing creates race condition window
  await runFFmpegProcessing();
  
  // Multiple concurrent Storage file uploads
  await Promise.all([/* many file uploads */]);
});
```

### Storage Trigger (Should NOT Hit Firestore Code)
```typescript
// This should NEVER call Firestore's createBeforeSnapshot
export const onUploadFileFinalize = onObjectFinalized(async (event) => {
  // BUG: Sometimes this event goes to createBeforeSnapshot instead!
  console.log('Storage event type:', event.type); // Should be storage, not firestore
});
```

## 🕐 Timing Notes

- **Bug frequency**: Intermittent - happens ~20% of the time
- **Race condition**: More likely with FFmpeg CPU load (simulates real video processing)
- **Timing window**: Bug occurs during concurrent Firestore→Storage event creation
- **Without FFmpeg**: Bug still occurs but takes longer to manifest

## 💡 Root Cause Analysis

The Firebase CLI emulator's event routing system has a race condition when:
1. Multiple trigger types are registered in the same Node.js process
2. Events arrive during specific timing windows  
3. Concurrent execution with CPU load creates larger timing windows
4. Event context gets polluted between trigger types

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
- Multiple trigger types are deployed
- High-concurrency workloads 
- CPU-intensive processing (video/audio encoding, ML inference, etc.)

**Workaround**: Avoid `--inspect-functions` in production-like testing, but this makes debugging much harder.

## 📝 Environment

- **Firebase CLI**: Latest (tested with multiple versions)
- **Node.js**: 20.x
- **OS**: macOS/Linux  
- **Functions Runtime**: nodejs20
- **Firebase Functions**: 6.4.0

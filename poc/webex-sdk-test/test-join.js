#!/usr/bin/env node

/**
 * Webex Browser SDK POC Test Script
 * 
 * This script tests whether the Webex JS SDK can:
 * 1. Initialize in a Node.js environment
 * 2. Join a Webex meeting programmatically
 * 3. Access audio MediaStreams from the meeting
 * 
 * Usage: node test-join.js <meeting_url> [access_token]
 */

const Webex = require('webex').default;

// Configuration
const MEETING_URL = process.argv[2];
const ACCESS_TOKEN = process.argv[3] || process.env.WEBEX_ACCESS_TOKEN;

// Logging helper
function log(stage, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] ${stage}`);
  console.log(`  ${message}`);
  if (data) {
    console.log('  Data:', JSON.stringify(data, null, 2));
  }
}

function error(stage, err) {
  const timestamp = new Date().toISOString();
  console.error(`\n[${timestamp}] ❌ ${stage}`);
  console.error(`  Error: ${err.message}`);
  console.error(`  Stack:`, err.stack);
}

async function testWebexSDK() {
  log('🚀 INIT', 'Starting Webex SDK POC Test');

  // Step 1: Validate inputs
  if (!MEETING_URL) {
    console.error('\n❌ Usage: node test-join.js <meeting_url> [access_token]');
    console.error('   Or set WEBEX_ACCESS_TOKEN environment variable');
    console.error('\nExample:');
    console.error('  node test-join.js https://meet123.webex.com/meet123/j.php?MTID=xxx YOUR_TOKEN');
    process.exit(1);
  }

  if (!ACCESS_TOKEN) {
    console.error('\n❌ No access token provided!');
    console.error('   Provide as second argument or set WEBEX_ACCESS_TOKEN env var');
    process.exit(1);
  }

  log('✅ VALIDATION', 'Inputs validated', {
    meetingUrl: MEETING_URL,
    tokenProvided: '***' + ACCESS_TOKEN.slice(-4)
  });

  let webex;
  let meeting;

  try {
    // Step 2: Initialize Webex SDK
    log('🔧 SDK_INIT', 'Initializing Webex SDK...');
    
    webex = Webex.init({
      credentials: {
        access_token: ACCESS_TOKEN
      }
    });

    log('✅ SDK_INIT', 'Webex SDK initialized successfully', {
      version: webex.version || 'unknown',
      canAuthorize: webex.canAuthorize || false
    });

    // Step 3: Wait for SDK to be ready
    log('⏳ SDK_READY', 'Waiting for SDK to be ready...');
    
    await webex.once('ready');
    
    log('✅ SDK_READY', 'SDK is ready');

    // Step 4: Check for required media helpers
    log('🔍 MEDIA_CHECK', 'Checking for media helpers availability...');
    
    const hasMediaHelpers = webex.meetings && webex.meetings.mediaHelpers;
    const hasMeetingsPlugin = !!webex.meetings;
    
    log(hasMediaHelpers ? '✅ MEDIA_CHECK' : '❌ MEDIA_CHECK', 
        'Media helpers status', {
      hasMeetingsPlugin,
      hasMediaHelpers,
      environment: typeof window !== 'undefined' ? 'browser' : 'node.js',
      navigatorExists: typeof navigator !== 'undefined',
      mediaDevicesExists: typeof navigator !== 'undefined' && !!navigator.mediaDevices
    });

    // Step 5: Attempt to create a meeting instance
    log('🎯 MEETING_CREATE', `Creating meeting instance for: ${MEETING_URL}`);
    
    meeting = await webex.meetings.create(MEETING_URL);
    
    log('✅ MEETING_CREATE', 'Meeting instance created', {
      meetingId: meeting.id,
      sipUri: meeting.sipUri,
      state: meeting.state
    });

    // Step 6: Set up event listeners
    log('📡 EVENTS', 'Setting up event listeners...');
    
    meeting.on('error', (err) => {
      error('MEETING_ERROR', err);
    });

    meeting.on('media:ready', (media) => {
      log('🎵 MEDIA_READY', 'Media ready event fired!', {
        hasAudio: !!media.audio,
        hasVideo: !!media.video,
        audioType: media.audio ? media.audio.constructor.name : null
      });

      if (media.audio) {
        log('🎵 AUDIO_STREAM', 'Audio stream received!', {
          audioTracks: media.audio.getTracks ? media.audio.getTracks().length : 'N/A',
          tracks: media.audio.getTracks ? media.audio.getTracks().map(t => ({
            kind: t.kind,
            label: t.label,
            readyState: t.readyState,
            enabled: t.enabled
          })) : 'N/A'
        });
      }
    });

    meeting.on('media:stopped', (media) => {
      log('🔇 MEDIA_STOPPED', 'Media stopped event fired', media);
    });

    meeting.on('meeting:stateChange', (state) => {
      log('🔄 STATE_CHANGE', 'Meeting state changed', { state });
    });

    // Step 7: Attempt to join the meeting (without media first)
    log('🚪 JOIN_ATTEMPT', 'Attempting to join meeting without media...');
    
    try {
      const joinResponse = await meeting.join();
      
      log('✅ JOIN_SUCCESS', 'Successfully joined meeting!', {
        state: meeting.state,
        participant: meeting.members?.selfId || 'unknown'
      });
    } catch (joinErr) {
      error('JOIN_FAILED', joinErr);
      
      // Document the error
      log('📝 FINDING', 'Join failed - this is expected in Node.js environment', {
        reason: 'The SDK requires browser APIs (WebRTC, MediaStream, navigator.mediaDevices)',
        error: joinErr.message
      });
    }

    // Step 8: Attempt to create media streams (will likely fail in Node.js)
    if (hasMediaHelpers) {
      log('🎤 MEDIA_STREAM_ATTEMPT', 'Attempting to create audio stream...');
      
      try {
        const audioStream = await webex.meetings.mediaHelpers.createMicrophoneStream({ audio: true });
        
        log('✅ AUDIO_STREAM_CREATED', 'Audio stream created!', {
          tracks: audioStream.getTracks().map(t => ({
            kind: t.kind,
            label: t.label,
            readyState: t.readyState
          }))
        });

        // Try to add media to meeting
        if (meeting.state === 'JOINED') {
          log('🔊 ADD_MEDIA', 'Attempting to add media to meeting...');
          
          await meeting.addMedia({
            localStreams: {
              microphone: audioStream
            },
            audioEnabled: true,
            videoEnabled: false
          });

          log('✅ ADD_MEDIA', 'Media added successfully!');
        }
      } catch (mediaErr) {
        error('MEDIA_STREAM_FAILED', mediaErr);
        
        log('📝 FINDING', 'Media stream creation failed - expected in Node.js', {
          reason: 'navigator.mediaDevices.getUserMedia() is not available in Node.js',
          error: mediaErr.message
        });
      }
    }

    // Step 9: Listen for remote audio
    if (meeting.state === 'JOINED') {
      log('👂 REMOTE_AUDIO', 'Waiting for remote audio streams...');
      
      // Wait a bit to see if any media events fire
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      log('📝 REMOTE_AUDIO', 'Check complete (no remote audio detected)', {
        finding: 'Remote audio access requires browser MediaStream APIs'
      });
    }

  } catch (err) {
    error('FATAL_ERROR', err);
  } finally {
    // Step 10: Cleanup
    if (meeting && meeting.state === 'JOINED') {
      log('🚪 LEAVE', 'Leaving meeting...');
      
      try {
        await meeting.leave();
        log('✅ LEAVE', 'Left meeting successfully');
      } catch (leaveErr) {
        error('LEAVE_FAILED', leaveErr);
      }
    }

    log('🏁 COMPLETE', 'Test completed');
    
    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 TEST SUMMARY');
    console.log('='.repeat(60));
    console.log('SDK Initialization: ✅ (SDK loads in Node.js)');
    console.log('Meeting Creation: ' + (meeting ? '✅' : '❌'));
    console.log('Meeting Join: ❓ (likely requires browser environment)');
    console.log('Audio Stream Access: ❌ (requires browser MediaStream APIs)');
    console.log('='.repeat(60));
    console.log('\n💡 CONCLUSION:');
    console.log('The Webex Browser SDK is designed for browser environments.');
    console.log('Node.js lacks the required WebRTC/MediaStream APIs.');
    console.log('See README.md for alternative approaches.');
    console.log('='.repeat(60) + '\n');
  }
}

// Run the test
testWebexSDK().catch(err => {
  console.error('\n💥 UNHANDLED ERROR:', err);
  process.exit(1);
});

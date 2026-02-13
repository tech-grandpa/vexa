#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node test-hybrid.js <meeting-url> <access-token>');
    console.error('');
    console.error('Example:');
    console.error('  node test-hybrid.js "https://example.webex.com/meet/john" "YourAccessToken"');
    console.error('  node test-hybrid.js "user@example.com" "YourAccessToken"');
    process.exit(1);
  }
  
  const meetingUrl = args[0];
  const accessToken = args[1];
  
  console.log('=== Webex SDK Hybrid POC Test ===\n');
  console.log(`Meeting: ${meetingUrl}`);
  console.log(`Token: ${accessToken.substring(0, 20)}...`);
  console.log('');
  
  // Launch browser
  console.log('🚀 Launching Chromium...');
  const browser = await chromium.launch({
    headless: false, // Set to true for headless mode
    args: [
      '--use-fake-ui-for-media-stream', // Auto-grant media permissions
      '--use-fake-device-for-media-stream',
    ]
  });
  
  const context = await browser.newContext({
    permissions: ['microphone', 'camera']
  });
  
  const page = await context.newPage();
  
  // Enable console logging from the page
  page.on('console', msg => {
    if (msg.text().startsWith('[WEBEX]')) {
      console.log(`  ${msg.text()}`);
    }
  });
  
  // Load the HTML file
  const htmlPath = path.join(__dirname, 'meeting.html');
  const htmlUrl = `file://${htmlPath}`;
  
  console.log(`📄 Loading ${htmlPath}...`);
  await page.goto(htmlUrl);
  
  // Inject configuration
  console.log('⚙️  Injecting config...');
  await page.evaluate(({ meetingUrl, accessToken }) => {
    window.__WEBEX_CONFIG = {
      meetingUrl,
      access_token: accessToken
    };
  }, { meetingUrl, accessToken });
  
  // Initialize and join meeting
  console.log('🔧 Initializing Webex SDK...');
  try {
    await page.evaluate(() => window.initWebex());
  } catch (err) {
    console.error('❌ Failed to initialize:', err.message);
    
    // Get logs for debugging
    const logs = await page.evaluate(() => window.__WEBEX_LOGS);
    console.log('\n📋 Webex logs:');
    logs.forEach(log => {
      console.log(`  [${log.timestamp}] ${log.message}`, log.data ? JSON.stringify(log.data, null, 2) : '');
    });
    
    await browser.close();
    process.exit(1);
  }
  
  // Wait a bit for audio to be ready
  console.log('⏳ Waiting for audio stream...');
  let audioReady = false;
  
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const status = await page.evaluate(() => window.__WEBEX_STATUS);
    
    if (status.audioReady) {
      audioReady = true;
      break;
    }
    
    if (status.error) {
      console.error(`❌ Error: ${status.error}`);
      break;
    }
    
    process.stdout.write('.');
  }
  
  console.log('');
  
  if (audioReady) {
    console.log('✅ Audio stream is ready!');
    
    // Get audio stream info
    const audioInfo = await page.evaluate(() => {
      const stream = window.__WEBEX_AUDIO_STREAM;
      if (!stream) return null;
      
      return {
        id: stream.id,
        active: stream.active,
        tracks: stream.getTracks().map(track => ({
          kind: track.kind,
          id: track.id,
          label: track.label,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState
        }))
      };
    });
    
    console.log('\n📊 Audio Stream Info:');
    console.log(JSON.stringify(audioInfo, null, 2));
    
    // Optional: Capture audio using Web Audio API
    console.log('\n🎙️  Testing audio capture...');
    try {
      const captureResult = await page.evaluate(() => {
        return new Promise((resolve, reject) => {
          try {
            const stream = window.__WEBEX_AUDIO_STREAM;
            if (!stream) {
              reject(new Error('No audio stream available'));
              return;
            }
            
            const audioContext = new AudioContext();
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            
            let sampleCount = 0;
            let peakAmplitude = 0;
            
            processor.onaudioprocess = (e) => {
              const input = e.inputBuffer.getChannelData(0);
              
              // Calculate peak amplitude
              for (let i = 0; i < input.length; i++) {
                const abs = Math.abs(input[i]);
                if (abs > peakAmplitude) {
                  peakAmplitude = abs;
                }
              }
              
              sampleCount += input.length;
            };
            
            source.connect(processor);
            processor.connect(audioContext.destination);
            
            // Capture for 2 seconds
            setTimeout(() => {
              processor.disconnect();
              source.disconnect();
              audioContext.close();
              
              resolve({
                samplesCaptured: sampleCount,
                sampleRate: audioContext.sampleRate,
                duration: sampleCount / audioContext.sampleRate,
                peakAmplitude
              });
            }, 2000);
            
          } catch (err) {
            reject(err);
          }
        });
      });
      
      console.log('✅ Audio capture test successful:');
      console.log(`   Samples: ${captureResult.samplesCaptured}`);
      console.log(`   Sample rate: ${captureResult.sampleRate} Hz`);
      console.log(`   Duration: ${captureResult.duration.toFixed(2)}s`);
      console.log(`   Peak amplitude: ${captureResult.peakAmplitude.toFixed(4)}`);
      
      if (captureResult.peakAmplitude > 0) {
        console.log('   ✅ Audio signal detected!');
      } else {
        console.log('   ⚠️  No audio signal detected (might be silence)');
      }
      
    } catch (err) {
      console.error('❌ Audio capture failed:', err.message);
    }
    
  } else {
    console.log('❌ Audio stream not ready after 30 seconds');
  }
  
  // Get final status
  const finalStatus = await page.evaluate(() => ({
    status: window.__WEBEX_STATUS,
    logCount: window.__WEBEX_LOGS.length
  }));
  
  console.log('\n📊 Final Status:');
  console.log(JSON.stringify(finalStatus.status, null, 2));
  
  // Leave meeting
  console.log('\n👋 Leaving meeting...');
  try {
    await page.evaluate(() => window.leaveMeeting());
    console.log('✅ Left successfully');
  } catch (err) {
    console.error('❌ Failed to leave:', err.message);
  }
  
  // Get all logs
  const allLogs = await page.evaluate(() => window.__WEBEX_LOGS);
  console.log(`\n📋 Captured ${allLogs.length} log entries`);
  
  // Close browser
  console.log('\n🔚 Closing browser...');
  await browser.close();
  
  console.log('\n✅ POC test complete!\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

import { spawn } from 'child_process';
import { createInterface } from 'readline';

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_TIME_WINDOW = 5000; // 5 seconds
let reconnectCount = 0;
let lastReconnectTime = Date.now();

function startProgram() {
  console.log('\n🔄 Starting grass-node...\n');
  
  const process = spawn('npm', ['start'], {
    stdio: ['inherit', 'pipe', 'pipe']
  });

  const rl = createInterface({
    input: process.stdout,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    console.log(line);
    
    if (line.includes('Initiating automatic reconnection')) {
      const currentTime = Date.now();
      
      if (currentTime - lastReconnectTime < RECONNECT_TIME_WINDOW) {
        reconnectCount++;
      } else {
        reconnectCount = 1;
      }
      
      lastReconnectTime = currentTime;

      if (reconnectCount >= MAX_RECONNECT_ATTEMPTS) {
        console.log('\n⚠️ Detected multiple reconnection attempts. Restarting program...');
        process.kill();
        reconnectCount = 0;
        setTimeout(startProgram, 5000);
      }
    }
  });

  process.stderr.on('data', (data) => {
    console.error(data.toString());
  });

  process.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.log('\n❌ Program crashed. Restarting in 5 seconds...');
      setTimeout(startProgram, 5000);
    }
  });
}

startProgram();

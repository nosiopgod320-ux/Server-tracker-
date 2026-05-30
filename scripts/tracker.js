require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Configuration
const PLACES = {
  Sea1: { id: 85211729168715, webhookKey: 'DISCORD_WEBHOOK_SEA1' },
  Sea2: { id: 79091703265657, webhookKey: 'DISCORD_WEBHOOK_SEA2' },
  Sea3: { id: 100117331123089, webhookKey: 'DISCORD_WEBHOOK_SEA3' }
};

const SCAN_INTERVALS = {
  scan1: 5 * 60 * 1000,  // 5 minutes between scans
  warningThreshold: 5 * 60 * 1000  // Send warning at 5 min before event
};

// Data storage paths
const dataDir = path.join(__dirname, '../data');
const serverDataFile = path.join(dataDir, 'servers.json');
const historyFile = path.join(dataDir, 'history.json');
const scanLogFile = path.join(dataDir, 'scan_log.json');

// Initialize data directory and files
function initializeDataFiles() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(serverDataFile)) {
    fs.writeFileSync(serverDataFile, JSON.stringify({
      sea1: { servers: [], lastScan: null, count: 0 },
      sea2: { servers: [], lastScan: null, count: 0 },
      sea3: { servers: [], lastScan: null, count: 0 }
    }, null, 2));
  }

  if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, JSON.stringify({
      allServersEver: [],
      removedServers: [],
      deadServers: []
    }, null, 2));
  }

  if (!fs.existsSync(scanLogFile)) {
    fs.writeFileSync(scanLogFile, JSON.stringify({
      scans: []
    }, null, 2));
  }
}

// Read server data
function readServerData() {
  const data = fs.readFileSync(serverDataFile, 'utf8');
  return JSON.parse(data);
}

// Write server data
function writeServerData(data) {
  fs.writeFileSync(serverDataFile, JSON.stringify(data, null, 2));
}

// Read history
function readHistory() {
  const data = fs.readFileSync(historyFile, 'utf8');
  return JSON.parse(data);
}

// Write history
function writeHistory(data) {
  fs.writeFileSync(historyFile, JSON.stringify(data, null, 2));
}

// Read scan log
function readScanLog() {
  const data = fs.readFileSync(scanLogFile, 'utf8');
  return JSON.parse(data);
}

// Write scan log
function writeScanLog(data) {
  fs.writeFileSync(scanLogFile, JSON.stringify(data, null, 2));
}

// Fetch servers from API
async function fetchServersForPlace(placeId) {
  try {
    // Replace with your actual API endpoint
    const response = await axios.get(`https://api.example.com/servers/${placeId}`);
    return response.data.servers || [];
  } catch (error) {
    console.error(`Error fetching servers for place ${placeId}:`, error.message);
    return [];
  }
}

// Check server status (alive/dead/dying)
async function checkServerStatus(server) {
  try {
    const response = await axios.get(`${server.joinLink}`, { timeout: 5000 });
    return {
      ...server,
      status: 'alive',
      lastCheck: new Date().toISOString()
    };
  } catch (error) {
    if (error.response?.status === 503 || error.code === 'ECONNREFUSED') {
      return {
        ...server,
        status: 'dead',
        lastCheck: new Date().toISOString()
      };
    }
    return {
      ...server,
      status: 'dying',
      lastCheck: new Date().toISOString()
    };
  }
}

// Generate unique server ID
function generateServerId(server) {
  return `${server.placeId}_${server.jobId}`;
}

// Perform full scan
async function performFullScan() {
  const serverData = readServerData();
  const history = readHistory();
  const scanLog = readScanLog();

  const currentScan = {
    timestamp: new Date().toISOString(),
    sea1: { new: [], updated: [], removed: [], dead: [], count: 0 },
    sea2: { new: [], updated: [], removed: [], dead: [], count: 0 },
    sea3: { new: [], updated: [], removed: [], dead: [], count: 0 }
  };

  // Scan each sea
  for (const [seaName, seaConfig] of Object.entries(PLACES)) {
    const seaKey = seaName.toLowerCase();
    console.log(`Scanning ${seaName}...`);

    const newServers = await fetchServersForPlace(seaConfig.id);
    const checkedServers = await Promise.all(
      newServers.map(server => checkServerStatus(server))
    );

    const previousServers = serverData[seaKey].servers || [];
    const previousIds = new Set(previousServers.map(s => generateServerId(s)));

    // Check for new servers
    const newServersList = [];
    const aliveServers = [];

    for (const server of checkedServers) {
      const serverId = generateServerId(server);

      if (!previousIds.has(serverId) && server.status === 'alive') {
        newServersList.push(server);
        currentScan[seaKey].new.push({
          jobId: server.jobId,
          placeId: seaConfig.id,
          name: server.name,
          players: server.players,
          maxPlayers: server.maxPlayers,
          joinLink: server.joinLink
        });
      }

      // Check for dead servers
      if (server.status === 'dead') {
        currentScan[seaKey].dead.push({
          jobId: server.jobId,
          placeId: seaConfig.id,
          name: server.name
        });
      }

      if (server.status === 'alive') {
        aliveServers.push(server);
      }
    }

    // Check for removed servers
    const currentIds = new Set(aliveServers.map(s => generateServerId(s)));
    for (const prevServer of previousServers) {
      const serverId = generateServerId(prevServer);
      if (!currentIds.has(serverId)) {
        currentScan[seaKey].removed.push({
          jobId: prevServer.jobId,
          placeId: seaConfig.id,
          name: prevServer.name
        });
      }
    }

    // Update server data
    serverData[seaKey] = {
      servers: aliveServers,
      lastScan: new Date().toISOString(),
      count: aliveServers.length
    };

    currentScan[seaKey].count = aliveServers.length;

    // Update history
    for (const server of newServersList) {
      if (!history.allServersEver.find(s => generateServerId(s) === generateServerId(server))) {
        history.allServersEver.push({
          ...server,
          discoveredAt: new Date().toISOString()
        });
      }
    }

    for (const server of currentScan[seaKey].dead) {
      if (!history.deadServers.find(s => s.jobId === server.jobId && s.placeId === server.placeId)) {
        history.deadServers.push({
          ...server,
          diedAt: new Date().toISOString()
        });
      }
    }
  }

  // Persist changes
  writeServerData(serverData);
  writeHistory(history);
  scanLog.scans.push(currentScan);
  writeScanLog(scanLog);

  return { serverData, currentScan, scanLog };
}

// Send Discord webhook
async function sendDiscordWebhook(webhookUrl, embed) {
  try {
    await axios.post(webhookUrl, { embeds: [embed] });
    console.log(`✅ Webhook sent successfully`);
  } catch (error) {
    console.error(`❌ Error sending webhook:`, error.message);
  }
}

// Get webhook URL from environment
function getWebhookUrl(webhookKey) {
  const url = process.env[webhookKey];
  if (!url) {
    console.warn(`⚠️  Environment variable ${webhookKey} is not set`);
  }
  return url;
}

// Validate environment variables
function validateEnvironment() {
  console.log('\n📋 Checking environment variables...');
  let isValid = true;

  for (const [seaName, seaConfig] of Object.entries(PLACES)) {
    const url = process.env[seaConfig.webhookKey];
    if (url) {
      console.log(`✅ ${seaConfig.webhookKey}: Configured`);
    } else {
      console.log(`❌ ${seaConfig.webhookKey}: NOT SET`);
      isValid = false;
    }
  }

  if (!isValid) {
    console.log('\n⚠️  Some webhooks are not configured. Messages will not be sent.');
    console.log('Please set environment variables or create a .env file.\n');
  }
  return isValid;
}

// Scan 1: Initial count
async function scan1NotifyFirstScan(currentScan) {
  console.log('\n📤 Sending Scan 1 notifications...');

  for (const [seaName, seaConfig] of Object.entries(PLACES)) {
    const seaKey = seaName.toLowerCase();
    const seaData = currentScan[seaKey];
    const webhookUrl = getWebhookUrl(seaConfig.webhookKey);

    if (!webhookUrl) {
      console.warn(`⚠️  Skipping ${seaName} - webhook not configured`);
      continue;
    }

    const embed = {
      title: `🔍 ${seaName} - Initial Scan Report`,
      color: 0x3498db,
      timestamp: new Date().toISOString(),
      fields: [
        {
          name: 'Total Servers Found',
          value: `${seaData.count}`,
          inline: true
        },
        {
          name: 'Place ID',
          value: `${seaConfig.id}`,
          inline: true
        },
        {
          name: 'Scan Time',
          value: new Date().toLocaleTimeString(),
          inline: true
        }
      ]
    };

    await sendDiscordWebhook(webhookUrl, embed);
  }
}

// Scan 2: New servers detected
async function scan2NotifyNewServers(currentScan) {
  console.log('\n📤 Sending Scan 2 notifications...');

  for (const [seaName, seaConfig] of Object.entries(PLACES)) {
    const seaKey = seaName.toLowerCase();
    const seaData = currentScan[seaKey];
    const webhookUrl = getWebhookUrl(seaConfig.webhookKey);

    if (!webhookUrl) continue;

    if (seaData.new.length === 0) {
      console.log(`ℹ️  ${seaName}: No new servers`);
      continue;
    }

    let description = '**New Servers Detected:**\n\n';
    seaData.new.forEach(server => {
      description += `🆕 **${server.name}**\n`;
      description += `   Job ID: \`${server.jobId}\`\n`;
      description += `   Players: ${server.players}/${server.maxPlayers}\n`;
      description += `   Place ID: ${server.placeId}\n\n`;
    });

    const embed = {
      title: `✨ ${seaName} - New Servers Report`,
      description: description,
      color: 0x2ecc71,
      timestamp: new Date().toISOString(),
      fields: [
        {
          name: 'Total New Servers',
          value: `${seaData.new.length}`,
          inline: true
        },
        {
          name: 'Total Active Servers',
          value: `${seaData.count}`,
          inline: true
        }
      ]
    };

    await sendDiscordWebhook(webhookUrl, embed);
  }
}

// Scan 3 & onwards: Detailed changes
async function scan3NotifyDetailedChanges(currentScan, scanNumber) {
  console.log(`\n📤 Sending Scan ${scanNumber} notifications...`);

  for (const [seaName, seaConfig] of Object.entries(PLACES)) {
    const seaKey = seaName.toLowerCase();
    const seaData = currentScan[seaKey];
    const webhookUrl = getWebhookUrl(seaConfig.webhookKey);

    if (!webhookUrl) continue;

    let description = '';

    // New servers
    if (seaData.new.length > 0) {
      description += '**➕ New Servers Added:**\n';
      seaData.new.forEach(server => {
        description += `🆕 **${server.name}**\n`;
        description += `   Job ID: \`${server.jobId}\`\n`;
        description += `   Place ID: ${server.placeId}\n`;
        description += `   Players: ${server.players}/${server.maxPlayers}\n\n`;
      });
    }

    // Removed servers
    if (seaData.removed.length > 0) {
      description += '**➖ Servers Removed:**\n';
      seaData.removed.forEach(server => {
        description += `❌ **${server.name}**\n`;
        description += `   Job ID: \`${server.jobId}\`\n`;
        description += `   Place ID: ${server.placeId}\n\n`;
      });
    }

    // Dead servers
    if (seaData.dead.length > 0) {
      description += '**💀 Dead Servers:**\n';
      seaData.dead.forEach(server => {
        description += `💥 **${server.name}**\n`;
        description += `   Job ID: \`${server.jobId}\`\n`;
        description += `   Place ID: ${server.placeId}\n\n`;
      });
    }

    if (description === '') {
      description = '✅ No changes detected since last scan.';
    }

    const embed = {
      title: `📊 ${seaName} - Scan #${scanNumber} Update`,
      description: description,
      color: seaData.new.length > 0 ? 0x2ecc71 : 0xf39c12,
      timestamp: new Date().toISOString(),
      fields: [
        {
          name: 'Active Servers',
          value: `${seaData.count}`,
          inline: true
        },
        {
          name: 'New',
          value: `${seaData.new.length}`,
          inline: true
        },
        {
          name: 'Removed',
          value: `${seaData.removed.length}`,
          inline: true
        },
        {
          name: 'Dead',
          value: `${seaData.dead.length}`,
          inline: true
        }
      ]
    };

    await sendDiscordWebhook(webhookUrl, embed);
  }
}

// Send event warning (5 minutes before)
async function sendEventWarning() {
  console.log('\n🔔 Sending event warnings...');

  for (const [seaName, seaConfig] of Object.entries(PLACES)) {
    const webhookUrl = getWebhookUrl(seaConfig.webhookKey);

    if (!webhookUrl) continue;

    const embed = {
      title: `⏰ ${seaName} - Event Starting Soon!`,
      description: '🔔 Event will start in **5 minutes**\n\nGet ready!',
      color: 0xe74c3c,
      timestamp: new Date().toISOString()
    };

    await sendDiscordWebhook(webhookUrl, embed);
  }
}

// Main tracking loop
let scanCount = 0;

async function startTracking() {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║   🚀 Server Tracker Started            ║');
  console.log('╚═══════════════════════════════════════╝\n');
  
  initializeDataFiles();
  validateEnvironment();

  console.log(`\n⏱️  Scan interval: 5 minutes\n`);

  setInterval(async () => {
    scanCount++;
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`📍 SCAN #${scanCount} - ${new Date().toLocaleString()}`);
    console.log(`${'═'.repeat(50)}`);

    try {
      const { serverData, currentScan } = await performFullScan();

      if (scanCount === 1) {
        await scan1NotifyFirstScan(currentScan);
      } else if (scanCount === 2) {
        await scan2NotifyNewServers(currentScan);
      } else if (scanCount >= 3) {
        await scan3NotifyDetailedChanges(currentScan, scanCount);
      }

      // Check if event is within 5 minutes
      const timeUntilEvent = checkTimeUntilEvent();
      if (timeUntilEvent && timeUntilEvent <= 5 * 60 * 1000) {
        await sendEventWarning();
      }

      console.log(`✅ Scan #${scanCount} completed`);

    } catch (error) {
      console.error(`❌ Error during scan ${scanCount}:`, error.message);
    }
  }, SCAN_INTERVALS.scan1);
}

// Placeholder for event time checking
function checkTimeUntilEvent() {
  // Replace with your actual event time logic
  // Return milliseconds until next event, or null if no event scheduled
  return null;
}

// Export functions
module.exports = {
  startTracking,
  performFullScan,
  sendDiscordWebhook,
  readServerData,
  writeServerData,
  readHistory,
  writeHistory,
  validateEnvironment
};

// Start if run directly
if (require.main === module) {
  startTracking();
}

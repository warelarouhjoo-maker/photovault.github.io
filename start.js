#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════╗
 * ║         PhotoVault — Démarrage          ║
 * ╚══════════════════════════════════════════╝
 * Lance les deux serveurs et affiche l'IP
 * + QR code pour accès mobile instantané.
 */

const { networkInterfaces } = require('os');
const qrcode = require('qrcode-terminal');

// ── Récupère toutes les IP locales disponibles ────────────────
function getLocalIPs() {
  const nets = networkInterfaces();
  const ips = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

// ── Affichage coloré dans le terminal ────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  white:  '\x1b[37m',
  bg:     '\x1b[44m',
};

function line(char = '─', len = 52) {
  return C.dim + char.repeat(len) + C.reset;
}

function printBanner() {
  console.clear();
  console.log('\n' + line('═'));
  console.log(C.bold + C.yellow + '  📷  PhotoVault' + C.reset + C.dim + '  — Serveur local' + C.reset);
  console.log(line('═'));
}

function printURLs(ips, portAdmin, portPublic) {
  console.log('\n' + C.bold + '  Adresses d\'accès :' + C.reset + '\n');

  // Ce PC
  console.log(C.dim + '  Sur ce PC :' + C.reset);
  console.log(C.cyan + `    🔐 Admin  →  http://localhost:${portAdmin}` + C.reset);
  console.log(C.cyan + `    🌐 Public →  http://localhost:${portPublic}` + C.reset);
  console.log();

  // Autres appareils
  if (ips.length === 0) {
    console.log(C.dim + '  Aucune interface réseau détectée.' + C.reset);
    return;
  }

  console.log(C.dim + '  Depuis un autre appareil (même réseau Wi-Fi) :' + C.reset);
  ips.forEach(ip => {
    console.log(C.green + C.bold + `    🔐 Admin  →  http://${ip}:${portAdmin}` + C.reset);
    console.log(C.green +          `    🌐 Public →  http://${ip}:${portPublic}` + C.reset);
  });
  console.log();
}

function printQR(ips, portAdmin, portPublic) {
  if (ips.length === 0) return;
  const ip = ips[0];

  console.log(line());
  console.log(C.bold + '  📱  Scanne pour ouvrir sur ton téléphone :' + C.reset);
  console.log();

  console.log(C.yellow + C.bold + '  Site ADMIN  ' + C.reset + C.dim + `(http://${ip}:${portAdmin})` + C.reset);
  qrcode.generate(`http://${ip}:${portAdmin}`, { small: true }, qr => {
    qr.split('\n').forEach(l => console.log('  ' + l));
  });

  console.log(C.green + C.bold + '  Site PUBLIC ' + C.reset + C.dim + `(http://${ip}:${portPublic})` + C.reset);
  qrcode.generate(`http://${ip}:${portPublic}`, { small: true }, qr => {
    qr.split('\n').forEach(l => console.log('  ' + l));
  });
}

function printFooter() {
  console.log(line());
  console.log(C.dim + '  Ctrl+C pour arrêter le serveur' + C.reset);
  console.log(line('═') + '\n');
}

// ── Démarrage ─────────────────────────────────────────────────
printBanner();
console.log(C.dim + '  Démarrage en cours…' + C.reset);

// Lance le vrai serveur
const { spawn } = require('child_process');
const server = spawn('node', ['server.js'], {
  cwd: __dirname,
  stdio: ['inherit', 'pipe', 'pipe']
});

let started = false;

server.stdout.on('data', data => {
  const msg = data.toString();

  // Attendre que les deux ports soient prêts
  if (msg.includes('Tables prêtes') && !started) {
    started = true;

    // Petit délai pour laisser les deux app.listen se terminer
    setTimeout(() => {
      const ips = getLocalIPs();
      printBanner();
      console.log(C.green + C.bold + '  ✅  Serveur démarré avec succès !' + C.reset + '\n');
      printURLs(ips, 3000, 3001);
      printQR(ips, 3000, 3001);
      printFooter();

      // Affiche un rappel si l'IP change (toutes les 30 secondes)
      setInterval(() => {
        const newIPs = getLocalIPs();
        const changed = JSON.stringify(newIPs) !== JSON.stringify(ips);
        if (changed) {
          console.log(C.yellow + '\n  ⚠️  IP changée ! Nouvelles adresses :' + C.reset);
          newIPs.forEach(ip => {
            console.log(C.green + `    🔐 Admin  →  http://${ip}:3000` + C.reset);
            console.log(C.green + `    🌐 Public →  http://${ip}:3001` + C.reset);
          });
          console.log();
        }
      }, 30000);

    }, 500);
  }

  // Afficher les logs MySQL/erreurs normalement
  if (msg.includes('✅') || msg.includes('❌') || msg.includes('🔐')) {
    process.stdout.write('  ' + msg);
  }
});

server.stderr.on('data', data => {
  console.error(C.red + '  ❌ ' + data.toString() + C.reset);
});

server.on('close', code => {
  console.log(C.red + `\n  Serveur arrêté (code ${code})` + C.reset);
  process.exit(code);
});

// Propager Ctrl+C
process.on('SIGINT', () => {
  console.log(C.yellow + '\n  Arrêt du serveur…' + C.reset);
  server.kill('SIGINT');
  setTimeout(() => process.exit(0), 500);
});

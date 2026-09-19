// Adapted from classy-cassie packages/cli/src/cloud-init.ts (Apache-2.0, Quotient).
// First-boot provisioning for a runner droplet. Nothing secret goes in here: the
// droplet metadata service serves user-data to anything running on the box.
// Credentials arrive afterwards, over ssh, on stdin.

export const DROPLET_IMAGE = "ubuntu-24-04-x64";
export const DEFAULT_REGION = "blr1";
export const DEFAULT_SIZE = "s-1vcpu-1gb";
export const RUNNER_PACKAGE = "@quotient-forecasting/strats";
/** Written by cloud-init when provisioning finishes, and polled by `strats deploy`. */
export const READY_MARKER = "/var/lib/strats/.provisioned";
export const UNIT_PATH = "/etc/systemd/system/strats@.service";
export const ENV_DIR = "/etc/strats";
export const envPath = (botId: string): string => `${ENV_DIR}/${botId}.env`;

/** Monthly list prices in USD for the sizes people pick. The DigitalOcean API's own number is printed once the droplet exists. */
export const SIZE_MONTHLY_USD: Record<string, number> = {
  "s-1vcpu-512mb-10gb": 4,
  "s-1vcpu-1gb": 6,
  "s-1vcpu-2gb": 12,
  "s-2vcpu-2gb": 18,
  "s-2vcpu-4gb": 24,
};

/** The systemd template unit. A redeploy rewrites it, so it lives on its own. */
export function renderUnit(runnerVersion: string): string {
  return `[Unit]
Description=strats runner (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=strats
Group=strats
EnvironmentFile=${ENV_DIR}/%i.env
Environment=STRATS_HOME=/var/lib/strats
Environment=STRATS_RUNNER_VERSION=${runnerVersion}
ExecStart=/usr/bin/strats run --id %i
Restart=always
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGTERM
StateDirectory=strats
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/var/lib/strats
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

/** Shell command that installs the runner at an exact version from npm. */
export function installRunnerCommand(runnerVersion: string): string {
  if (!/^[0-9A-Za-z.+-]+$/.test(runnerVersion)) throw new Error("unexpected character in the runner version");
  return `npm install --global --omit=dev --no-audit --no-fund ${RUNNER_PACKAGE}@${runnerVersion}`;
}

/** Shell command that installs the runner from a tarball already copied to the droplet. */
export function installTarballCommand(remoteTarball: string): string {
  if (!/^\/tmp\/[A-Za-z0-9._-]+\.tgz$/.test(remoteTarball)) throw new Error("unexpected tarball path");
  return `npm install --global --omit=dev --no-audit --no-fund ${remoteTarball}`;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n")
    .trimEnd();
}

export interface CloudInitParams {
  /** Runner version to install. Pinned to this CLI's version so the two agree. */
  runnerVersion: string;
  /** Skip the npm install; the tarball is uploaded after boot. */
  tarball?: boolean;
}

export function renderCloudInit(params: CloudInitParams): string {
  const install = params.tarball ? "echo 'awaiting the runner tarball from strats deploy'" : installRunnerCommand(params.runnerVersion);

  return `#cloud-config
# Refresh the apt indexes, but skip a full distro upgrade: on a 1 vCPU droplet
# it adds minutes to first boot. unattended-upgrades carries security patches.
package_update: true
packages:
  - curl
  - ca-certificates
  - ufw
  - unattended-upgrades

write_files:
  - path: ${UNIT_PATH}
    permissions: '0644'
    content: |
${indent(renderUnit(params.runnerVersion), 6)}

  - path: /etc/systemd/journald.conf.d/strats.conf
    permissions: '0644'
    content: |
      [Journal]
      Storage=persistent
      SystemMaxUse=200M

  - path: /etc/ssh/sshd_config.d/strats.conf
    permissions: '0644'
    content: |
      PasswordAuthentication no
      PermitRootLogin prohibit-password
      KbdInteractiveAuthentication no

runcmd:
  - [ sh, -c, "fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab" ]
  - [ sh, -c, "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -" ]
  - [ sh, -c, "apt-get install -y nodejs" ]
  - [ sh, -c, "id -u strats >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/strats --shell /usr/sbin/nologin strats" ]
  - [ sh, -c, "install -d -m 0750 -o strats -g strats ${ENV_DIR} /var/lib/strats" ]
  - [ sh, -c, "${install}" ]
  - [ sh, -c, "ufw --force reset >/dev/null 2>&1; ufw default deny incoming; ufw default allow outgoing; ufw allow 22/tcp; ufw --force enable" ]
  - [ systemctl, restart, systemd-journald ]
  - [ systemctl, restart, ssh ]
  - [ systemctl, daemon-reload ]
  - [ sh, -c, "install -d -m 0750 -o strats -g strats /var/lib/strats && touch ${READY_MARKER} && chown strats:strats ${READY_MARKER}" ]
`;
}

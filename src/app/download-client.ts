import { ipcMain } from "electron";
import { app, shell } from "electron";

import path from "path";
import fs from "fs";
import axios from "axios";
import MultiStream from "multistream";
import unzipper from "unzipper";

import logger from "electron-log/main";

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { t } from "i18next";
import { APP_CONFIG } from "./config";
import { MAIN_WINDOW } from "./app";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

let downloadProgress = 0;
let currentFileDownload = "";
let downloadEta = -1;

ipcMain.handle("get-download-progress", async () => {
    return downloadProgress;
});

ipcMain.handle("get-download-file", async () => {
    return currentFileDownload;
});

ipcMain.handle("get-download-eta", async () => {
    return downloadEta;
});

ipcMain.handle("download-client", async (_, provider) => {
    downloadProgress = 0;
    currentFileDownload = "";
    downloadEta = -1;

    if (provider === "steam") {
        return new Promise<void>(async (resolve, reject) => {
            try {
                await DownloadClient(APP_CONFIG.clientPath, (err) => {
                    if (err) {
                        logger.error(err);
                        reject(err);
                        return;
                    }
                    resolve();
                });
            } catch (e) {
                logger.error(e);
                reject(e);
            } finally {
                MAIN_WINDOW.webContents.send("download-complete");
                resolve();
            }
        });
    }

    if (provider === "github") {
        return new Promise<void>(async (resolve, reject) => {
            try {
                await GithubClient(APP_CONFIG.clientPath, (err) => {
                    if (err) {
                        logger.error(err);
                        reject(err);
                        return;
                    }
                    resolve();
                });
            } catch (e) {
                logger.error(e);
                reject(e);
            } finally {
                MAIN_WINDOW.webContents.send("download-complete");
                resolve();
            }
        });
    }

    if (provider === "direct") {
        const CLIENT_URL =
            "aHR0cDovL3RhZGV1Y2NpLmRldi9tYXBsZXN0b3J5XzJfY2xpZW50Ljd6";

        // Decode the URL
        const decodedUrl = Buffer.from(CLIENT_URL, "base64").toString("utf-8");

        logger.info("Direct download link:", decodedUrl);

        await shell.openExternal(decodedUrl);
        logger.info("Direct download link opened in browser:", decodedUrl);
        MAIN_WINDOW.webContents.send("download-complete");

        return new Promise<void>((resolve) => {
            resolve();
        });
    }

    return new Promise<void>((resolve, reject) => {
        logger.error("Download client not supported for provider", provider);
        reject(new Error("Download client not supported for provider"));
        MAIN_WINDOW.webContents.send("download-complete");
    });
});

const APP_ID = 560380;
const DEPOT_ID = 560381;
const MANIFEST_ID = "3190888022545443868";

const DOWNLOADER_EXE = app.isPackaged
    ? path.join(process.resourcesPath, "./DepotDownloaderMod.dll")
    : path.join(__dirname, "../../src/downloader/DepotDownloaderMod.dll");

const MANIFEST_INFO = app.isPackaged
    ? path.join(process.resourcesPath, "./560381_3190888022545443868.manifest")
    : path.join(
          __dirname,
          "../../src/downloader/560381_3190888022545443868.manifest",
      );

const DEPOT_KEY = app.isPackaged
    ? path.join(process.resourcesPath, "./depot.key")
    : path.join(__dirname, "../../src/downloader/depot.key");
const KEY = Buffer.from(
    "9bdb5693b8cbe239bd87eb147abacb8ae4aa446744d1ca4a323bac611174bc8c",
    "hex",
);

let ActiveDownloadProcess: ChildProcessWithoutNullStreams | null;

export const KillDownloadClient = () => {
    if (ActiveDownloadProcess) {
        ActiveDownloadProcess.kill();
        ActiveDownloadProcess = null;
    }
};

const hasDotnet = () => {
    return new Promise((resolve, reject) => {
        const dotnetRuntimesProcess = spawn("dotnet", ["--list-runtimes"]);
        let runtimeListOutput = "";

        dotnetRuntimesProcess.stdout.on("data", (data) => {
            runtimeListOutput += data.toString();
        });

        dotnetRuntimesProcess.on("close", (code) => {
            if (code !== 0) {
                reject("Error checking .NET runtimes");
                return;
            }

            // Check if any installed runtimes are 9.0 or higher
            const runtimeLines = runtimeListOutput.trim().split("\n");
            let hasDotnet9OrHigher = false;

            runtimeLines.forEach((line) => {
                const runtimeVersion = line.split(" ")[1];
                if (runtimeVersion) {
                    const [major, minor] = runtimeVersion
                        .split(".")
                        .map(Number);
                    if (major > 9 || (major === 9 && minor >= 0)) {
                        hasDotnet9OrHigher = true;
                    }
                }
            });

            if (hasDotnet9OrHigher) {
                resolve(true);
            } else {
                reject();
            }
        });
    });
};

export const DownloadClient = async (
    clientPath: string,
    cb: (err: Error) => void,
) => {
    if (ActiveDownloadProcess) {
        logger.error(
            t("downloader.already.running", "Download process already running"),
        );
        return;
    }

    try {
        await hasDotnet();
    } catch (err) {
        cb(
            new Error(
                t(
                    "downloader.dotnet.not.installed",
                    ".NET 9.0+ is not installed",
                ),
            ),
        );
        shell.openExternal(
            "https://dotnet.microsoft.com/en-us/download/dotnet/9.0/runtime?cid=getdotnetcore",
        );
        return;
    }

    const args = [
        `${DOWNLOADER_EXE}`,
        `-app`,
        APP_ID.toString(),
        `-depot`,
        DEPOT_ID.toString(),
        `-depotkeys`,
        DEPOT_KEY,
        `-manifest`,
        MANIFEST_ID,
        `-manifestfile`,
        MANIFEST_INFO,
        `-dir`,
        clientPath,
        `-validate`,
    ];

    // Download the client
    ActiveDownloadProcess = spawn(`dotnet`, args, {});

    let startTime = Date.now();
    let lastPercent = 0;
    let percentDiffs = [] as { diff: number; time: number }[];

    const etaInterval = setInterval(() => {
        const timeElapsed = Date.now() - startTime;

        // Calculate the average download speed
        const averageSpeed =
            percentDiffs.reduce((acc, curr) => acc + curr.diff, 0) /
            percentDiffs.length;

        const timeRemaining = Math.round(100 / averageSpeed);

        downloadEta = Math.max(
            Math.round(timeRemaining - timeElapsed / 1000),
            0,
        );
    }, 1000);

    const p = new Promise<void>((resolve, reject) => {
        if (!ActiveDownloadProcess) {
            reject(
                new Error(
                    t(
                        "downloader.download.process.not.found",
                        "Download process not found",
                    ),
                ),
            );
            return;
        }

        ActiveDownloadProcess.stdout.on("data", (data) => {
            let lines = data.toString().split("\n");

            if (lines.length === 0) lines = [data.toString()];

            for (const line of lines) {
                if (line.match(/(\d+)\.(\d+)%/)) {
                    // download progress
                    const match = line.match(/(\d+\.\d+)%/);
                    const percent = parseFloat(match[1]);
                    downloadProgress = percent;

                    currentFileDownload = line.replace(clientPath, "");

                    const diff = percent - lastPercent;
                    lastPercent = percent;
                    percentDiffs.push({
                        diff,
                        time: Date.now(),
                    });
                } else if (line.trim() !== "") {
                    // setDoiwnl(line.replace(clientPath, ""));
                    logger.info(line);
                }
            }
        });

        ActiveDownloadProcess.stderr.on("data", (data) => {
            console.error(`stderr: ${data}`);
            reject(new Error(data.toString()));
        });

        ActiveDownloadProcess.on("close", (code) => {
            console.log(`Child process exited with code ${code}`);

            clearInterval(etaInterval);
            if (code === 0) {
                resolve();
                return;
            }

            cb(new Error("Download process exited with code " + code));
            resolve();
        });
    });

    await p;

    ActiveDownloadProcess = null;
};

// https://github.com/shuabritze/adventure-island-online-2/releases/latest
const GITHUB_CHUNKS = [
    {
        url: "https://github.com/shuabritze/adventure-island-online-2/releases/latest/download/MapleStory2-Client.zip.001",
        fileName: "MapleStory2-Client.zip.001",
    },
    {
        url: "https://github.com/shuabritze/adventure-island-online-2/releases/latest/download/MapleStory2-Client.zip.002",
        fileName: "MapleStory2-Client.zip.002",
    },
    {
        url: "https://github.com/shuabritze/adventure-island-online-2/releases/latest/download/MapleStory2-Client.zip.003",
        fileName: "MapleStory2-Client.zip.003",
    },
    {
        url: "https://github.com/shuabritze/adventure-island-online-2/releases/latest/download/MapleStory2-Client.zip.004",
        fileName: "MapleStory2-Client.zip.004",
    },
    {
        url: "https://github.com/shuabritze/adventure-island-online-2/releases/latest/download/MapleStory2-Client.zip.005",
        fileName: "MapleStory2-Client.zip.005",
    },
    {
        url: "https://github.com/shuabritze/adventure-island-online-2/releases/latest/download/MapleStory2-Client.zip.006",
        fileName: "MapleStory2-Client.zip.006",
    },
] as {
    url: string;
    fileName: string;
}[];

const GithubClient = async (clientPath: string, cb: (err: Error) => void) => {
    // ensure clientPath exists
    if (!fs.existsSync(clientPath)) {
        fs.mkdirSync(clientPath, { recursive: true });
    }

    const chunkResponses = [] as axios.AxiosResponse<Readable, any>[];

    for (const chunk of GITHUB_CHUNKS) {
        currentFileDownload = `Fetching ${chunk.fileName}...`;

        const downloadResponse = await axios<Readable>({
            url: chunk.url,
            method: "GET",
            responseType: "stream",
            headers: {
                Accept: "application/octet-stream",
            },
        });

        if (downloadResponse.status !== 200) {
            logger.error(
                `Error downloading ${chunk.fileName}: ${downloadResponse.status} ${downloadResponse.statusText}`,
            );
            cb(new Error("Error downloading " + chunk.fileName));
            return;
        }

        chunkResponses.push(downloadResponse);
    }

    const totalLength = chunkResponses.reduce((acc, chunk) => {
        const contentLength = chunk.headers["content-length"];
        if (contentLength) {
            return acc + parseInt(contentLength, 10);
        }
        return acc;
    }, 0);
    let unpackedBytes = 0;

    const ms = new MultiStream(
        GITHUB_CHUNKS.map((chunk, idx) => {
            const response = chunkResponses[idx];
            if (!response) {
                throw new Error(`Response not found for ${chunk.fileName}`);
            }

            // pipe the resposne to the multi stream as a reader
            return response.data;
        }),
    );

    ms.on("error", (err) => {
        logger.error("Error in multi stream", err);
        cb(err);
    });

    await new Promise<void>((resolve, reject) => {
        ms.pipe(unzipper.Parse({}))
            .on("entry", (entry) => {
                unpackedBytes += entry.vars.compressedSize;
                downloadProgress = Math.round(
                    (unpackedBytes / totalLength) * 100,
                );
                currentFileDownload = `${downloadProgress}% ${entry.path}`;

                if (entry.type === "Directory") {
                    // if entry is a directory, create it
                    fs.mkdirSync(path.join(clientPath, entry.path), {
                        recursive: true,
                    });
                    entry.autodrain();
                    return;
                }

                // create parent directory if it doesn't exist
                const parentDir = path.join(
                    clientPath,
                    path.dirname(entry.path),
                );
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }

                // write file
                entry.pipe(
                    fs.createWriteStream(path.join(clientPath, entry.path)),
                );
            })
            .on("close", () => {
                logger.info("Unzipped files to", clientPath);
                resolve();
            })
            .on("error", (err) => {
                logger.error("Error unzipping files", err);
                reject(err);
            });
    });
};

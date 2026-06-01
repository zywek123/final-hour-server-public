import path from "path";
import fs from "fs";
import enet from "enet";
import logger from "./logger";
import map from "./world_map";
import language_channel from "./language_channel";
import str from "@supercharge/strings";
import * as file from "./file";
import weapon from "./weapon";
import Database from "./database";
import { LoggedEntry } from "./database/models/log_types";
import discord from "./discord";
import leaderboard from "./leaderboard";
import Player from "./objects/player";
import Event_handeler from "./event_handeler";
import Game from "./game_mode";
import Log from "./database/models/log";
import EventEmitter from "./event_emitter";
import WorldMap from "./world_map";
import consts from "./consts";
import { json } from "sequelize";

export default class Server extends EventEmitter<Server> {
    database: Database;
    maps: Record<string, map>;
    event_handeler: Event_handeler;
    players: Player[];
    used_voice_channel: number = consts.CHANNEL_VOICECHAT;
    leaderboard: leaderboard;
    games: Game[];
    id: number;
    updating: boolean;
    language_channels: { [key: string]: language_channel };
    discord: discord;
    should_tick: boolean;
    host: any;
    weapon_data: Record<string, any> = {};
    authorised_names: string[] = [];
    contributors: string[] = [];
    readonly logs = Log;
    constructor(
        address: string,
        port: number,
        event_handeler: typeof Event_handeler,
        ignore_discord = false
    ) {
        super();
        this.event_handeler = new event_handeler(this);
        this.players = [];
        this.updating = false;
        this.database = new Database(this);
        this.leaderboard = new leaderboard(this);
        this.games = [];
        this.id = 0;
        var self = this;
        process.on("uncaughtException", async function (err) {
            console.log(err);
            process.exit(1);
        });
        this.maps = {};
        this.language_channels = {
            english: new language_channel(self, "english"),
        };
        this.update_contributors();
        this.update_authorised_names();
        this.update_weapons();
        this.discord = new discord(this, ignore_discord);
        this.discord.callbacks();
        this.should_tick = true;
        this.database.initialize().then(async (value) => {
            this.log_startup_diagnostics();
            await this.update_maps();
            this.system_log("Initializing server...");
            this.host = new enet.createServer(
                {
                    address: {
                        address: "0.0.0.0",
                        port: "13000",
                    },
                    peers: 64,
                    channels: 256,
                    down: 0,
                    up: 0,
                },
                function (
                    err: any,
                    host: {
                        address: () => {
                            (): any;
                            new (): any;
                            address: any;
                            port: any;
                        };
                        on: (arg0: string, arg1: (peer: any) => void) => void;
                        start: (arg0: number) => void;
                    }
                ) {
                    if (err) {
                        console.log(err);
                        return;
                    }
                    console.log(
                        "host ready on %s:%s",
                        host.address().address,
                        host.address().port
                    );
                    const peerRateMap = new Map<any, { count: number; window: number }>();
                    const RATE_LIMIT = 120;
                    const RATE_WINDOW_MS = 1000;
                    host.on("connect", (peer: any) => {
                        logger.info("net", "peer connected", { address: peer.address().address });
                        peerRateMap.set(peer, { count: 0, window: Date.now() });
                        peer.on("disconnect", () => {
                            logger.info("net", "peer disconnected", { address: peer.address().address });
                            peerRateMap.delete(peer);
                            self.event_handeler.disconnect(peer);
                        });
                        peer.on("message", (packet: any, channel: number): void => {
                            const rate = peerRateMap.get(peer);
                            if (rate) {
                                const now = Date.now();
                                if (now - rate.window > RATE_WINDOW_MS) {
                                    rate.count = 0;
                                    rate.window = now;
                                }
                                rate.count++;
                                if (rate.count > RATE_LIMIT) {
                                    logger.error("net", "rate limit exceeded", { address: peer.address().address });
                                    peer.disconnectNow(0);
                                    return;
                                }
                            }
                            if (channel < consts.CHANNEL_VOICECHAT) {
                                let data: any;
                                try {
                                    data = JSON.parse(packet.data().toString());
                                } catch {
                                    logger.error("event", "malformed packet", undefined);
                                    return;
                                }
                                if (!data.event || !self.event_handeler.events[data.event]) {
                                    logger.error("event", `unknown event: ${data.event}`, undefined);
                                    return;
                                }
                                const log_data = data.data ? { ...data.data } : undefined;
                                if (log_data && log_data.password !== undefined) log_data.password = "***";
                                logger.info("event", data.event, log_data ? JSON.stringify(log_data).slice(0, 120) : undefined);
                                try {
                                    const result = self.event_handeler.events[data.event].bind(
                                        self.event_handeler
                                    )(peer, data.data);
                                    if (result instanceof Promise) result.catch((err: any) => logger.error("event", `async error in ${data.event}`, String(err)));
                                } catch (err) {
                                    logger.error("event", `error in ${data.event}`, String(err));
                                }
                            } else if (channel >= consts.CHANNEL_VOICECHAT) {
                                try {
                                    self.event_handeler.events["voice_chat"].bind(self.event_handeler)(peer, packet.data());
                                } catch(err) {
                                    logger.error("event", "error in voice_chat", String(err));
                                }
                            }
                        });
                    });
                    host.start(1);
                    self.tick();
                }
            );
        });
    }
    sleep(): Promise<void> {
        return new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
    get_id(): number {
        this.id++;
        return this.id;
    }
    sleep_for(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    update_weapons(): void {
        this.weapon_data = {};
        for (var i of fs.readdirSync("./weapons/")) {
            const file_path = `./weapons/${i}`;
            const name = path.parse(file_path).name;
            this.weapon_data[name] = JSON.parse(
                fs.readFileSync(file_path).toString()
            );
        }
    }

    update_authorised_names(): void {
        this.authorised_names = str(
            fs.readFileSync("./authorised_names", { encoding: "utf8" })
        )
            .lines()
            .map((value) => {
                return value.toLowerCase().trim();
            });
    }

    update_contributors(): void {
        this.contributors = str(
            fs.readFileSync("./contributors.txt", { encoding: "utf8" })
        )
            .lines()
            .map((value) => {
                return value.trim();
            });
    }

    log_startup_diagnostics(): void {
        const checks: { label: string; path: string }[] = [
            { label: "database",       path: "./database.sqlite3" },
            { label: "contributors",   path: "./contributors.txt" },
            { label: "authorised_names", path: "./authorised_names" },
            { label: "sm.txt",         path: "./sm.txt" },
        ];
        for (const { label, path: p } of checks) {
            if (fs.existsSync(p)) logger.info("startup", `${label} found`);
            else logger.warn("startup", `${label} not found`, p);
        }
        if (fs.existsSync("./maps")) {
            const maps = fs.readdirSync("./maps").filter(f => f.endsWith(".map"));
            logger.info("startup", `maps folder found`, { count: maps.length, files: maps });
        } else {
            logger.warn("startup", "maps folder not found");
        }
    }

    async update_maps(): Promise<void> {
        const map_files = fs.readdirSync("./maps/");
        for (let file of map_files) {
            try {
                const map = await WorldMap.compileMapFromFile(
                    this,
                    `maps/${file}`
                );
                this.maps[map.mapName] = map;
                logger.info("maps", `loaded ${map.mapName}`);
            } catch (err) {
                logger.error("maps", `failed to load ${file}`, String(err));
            }
        }
    }

    make_weapon({
        owner,
        name,
        upgraded = false,
    }: {
        owner: Player;
        name: string;
        upgraded?: boolean;
    }): weapon {
        if (name in this.weapon_data) {
            var data = upgraded
                ? this.weapon_data[name].upgrade
                : this.weapon_data[name];
            return new weapon({
                server: this,
                owner: owner,
                name: data.name ?? name,
                ammo: data.max_loaded_ammo ?? 0,
                max_ammo: data.max_loaded_ammo ?? 0,
                max_reserved_ammo: data.max_reserve_ammo ?? 0,
                automatic: data.fully_automatic ?? false,
                melee: data.melee ?? false,
                range: data.range ?? 1,
                sounds_path: data.sounds_path ?? `weapons/${name}`,
                reserved_ammo: data.max_reserve_ammo ?? 0,
                fire_time: 1000 / data.bullets_per_second ?? -1,
                reload_time: data.reload_time ?? -1,
                shot_cost: data.shot_cost ?? 1,
                upgraded: upgraded,
                recoil_chance: data.chants_of_recoil_per_shot ?? 0,
                damage: data.damage ?? 1,
            });
        }
        throw new Error("Attempted to load a weapon that is not defined");
    }
    async tick(): Promise<void> {
        this.emit("tick");
        if (this.should_tick) setTimeout(() => this.tick(), 25);
    }
    async create_map({
        name,
        minx,
        maxx,
        miny,
        maxy,
        minz,
        maxz,
    }: {
        name: string;
        minx: number;
        maxx: number;
        miny: number;
        maxy: number;
        minz: number;
        maxz: number;
    }): Promise<map> {
        const path = `maps/${name}.map`;
        if (!(await file.exists(path))) {
            const map_data = `<?xml version="1.0" encoding="UTF-8"?>
{# This map was generated automatically. After making your initial update, please delete these comments.
For any assistance with building please read the docs found at https://finalhour.lowerelements.club/docs.
While building remember that you can use the built in scripting for maps. You can find the documentation at https://mozilla.github.io/nunjucks/templating.
#}
<map xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://final-hour.net/map_schema.xsd"
    bounds="${minx} ${maxx} ${miny} ${maxy} ${minz} ${maxz}">
    <head></head>
    <body>
        <platform bounds="${minx} ${maxx} ${miny} ${maxy} ${minz} ${maxz}" type="wood"/>
    </body>
</map>
            `;
            await fs.promises.writeFile(path, map_data);
            var _map = await WorldMap.compileMapFromFile(this, path);
            this.maps[_map.mapName] = _map;
            return _map;
        }
        throw new Error("Map couldn't be created.");
    }
    send(
        peer: any,
        channel: number,
        event: string,
        data: Record<string, any> | any,
        reliable = true
    ): void {
        if (channel < consts.CHANNEL_VOICECHAT) data = JSON.stringify({ event: event, data: data });
        let flag = reliable
            ? enet.PACKET_FLAG.RELIABLE
            : enet.PACKET_FLAG.UNRELIABLE_FRAGMENT;
        let packet = new enet.Packet(
            data,
            flag
        );
        peer.send(channel, packet);
    }
    add_game(game: Game): void {
        this.games.push(game);
    }
    add_player(player: Player): void {
        this.players.push(player);
    }
    remove_player(player: Player): void {
        this.players.splice(this.players.indexOf(player), 1);
    }
    remove_game(game: Game, destroy = false): void {
        this.games.splice(this.games.indexOf(game), 1);
        if (destroy) {
            game.destroy();
        }
    }
    get_game_by_name(name: string): Game | undefined {
        for (var i of this.games) {
            if (i.name === name) return i;
        }
    }
    speak(text: string, interupt = false, buffer = "", sound = ""): void {
        for (let i of this.players) {
            i.speak(text, interupt, buffer, sound);
        }
    }
    async offline_speak(
        player: string,
        text: string,
        interupt = false,
        buffer = "",
        sound = "",
        sender_user: Player | null = null
    ): Promise<void> {
        if (this.get_by_username(player)) {
            this.get_by_username(player)?.speak(text, interupt, buffer, sound);
        } else {
            const user = await this.database.users.findOne({
                where: { username: player },
            });
            if (user) {
                user.off_msg_queue = user.off_msg_queue.concat([
                    [text, interupt, buffer, sound],
                ]);
                await user.save();
            }
        }
    }
    speak_unbound(
        text: string,
        interupt = false,
        buffer = "",
        sound = ""
    ): void {
        for (var i of this.players) {
            if (!i.game) {
                i.speak(text, interupt, buffer, sound);
            }
        }
    }
    speakbuilders(
        text: string,
        interupt = false,
        buffer = "",
        sound = ""
    ): void {
        for (let i of this.players) {
            if (i.builder) {
                i.speak(text, interupt, buffer, sound);
            }
        }
    }
    speakmods(text: string, interupt = false, buffer = "", sound = ""): void {
        for (let i of this.players) {
            if (i.moderator) {
                i.speak(text, interupt, buffer, sound);
            }
        }
    }
    speakcontributors(
        text: string,
        interupt = false,
        buffer = "",
        sound = ""
    ): void {
        for (let i of this.players) {
            if (i.contributor) {
                i.speak(text, interupt, buffer, sound);
            }
        }
    }
    get_by_peer(peer: any): Player | undefined {
        for (var i of this.players) {
            if (i.peer === peer) {
                return i;
            }
        }
    }
    send_all(
        channel: number,
        event: string,
        data: Record<string, any>,
        reliable = true
    ): void {
        for (var i of this.players) {
            i.send(channel, event, data, reliable);
        }
    }
    get_by_username(username: string): Player | undefined {
        username = username.toLowerCase();
        for (var i of this.players) {
            if (i.user.username.toLowerCase() === username) {
                return i;
            }
        }
    }
    system_log(message: string): Promise<LoggedEntry> {
        return this.logs.createEntry({
            eventType: "system",
            eventData: { message: message },
        });
    }
    get_available_voice_channel(): number {
        this.used_voice_channel = this.used_voice_channel + 1;
        if (this.used_voice_channel >= 256) this.used_voice_channel = consts.CHANNEL_VOICECHAT;
        return this.used_voice_channel;
    }
}

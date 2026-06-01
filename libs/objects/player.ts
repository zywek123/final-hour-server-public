import consts from "../consts";
import entity from "./entity";
import * as file from "../file";
import Inventory from "../inventory";
import timer from "../timer";
import weapon_manager from "../weaponmanager";
import menu from "../menu";
import zomby_game from "../zomby_game";
import map from "../world_map";
import * as random from "../random";
import Weapon_manager from "../weaponmanager";
import Character from "../character";
import WorldMap from "../world_map";
import Game from "../game_mode";
import Language_channel from "../language_channel";
import Game_object from "./object";
import Zomby from "./zomby";
import Grenade_entity from "./grenade";
import Server from "../networking";
import User from "../database/models/player";
import channel_id from "../channel_id";
import PerkManager from "../perk_manager";

export default class Player extends entity {
    user: User;
    isContributor: boolean = false;
    weapon_manager: Weapon_manager;
    dead: boolean;
    character?: Character;
    game?: Game;
    being_hit: boolean;
    voice_channel: number;
    chat_timer: timer;
    revive_timer: timer;
    revive_time: number;
    quick_revive: boolean;
    revivable_sound: boolean;
    low_health: boolean;
    reload_voice: boolean = true;
    speed_cola: boolean = false;
    total_shots: number = 0;
    total_hits: number = 0;
    inventory: Inventory;
    reply_list: any[];
    typing: boolean;
    typing_timer: timer;
    health_timer: timer;
    invisible: boolean;
    language_channel?: Language_channel;
    language_channel_name?: string;
    readonly perks: PerkManager;
    defaultMaxHp = 100;
    constructor({
        server,
        peer,
        user,
        map,
        contributor = false,
        language_channel_name = "english",
        hp = 100,
    }: {
        server: Server;
        peer: any;
        user: User;
        map: WorldMap;
        contributor?: boolean;
        language_channel_name?: string;
        hp?: number;
    }) {
        super(
            { server: server, name: user.username, map: map, hp: hp },
            true,
            peer
        );
        this.user = user;
        this.isContributor = contributor;
        this.quick_revive = false;
        server.language_channels[language_channel_name].add_player(this);
        this.being_hit = false;
        this.voice_channel = this.server.get_available_voice_channel();
        this.chat_timer = new timer();
        this.dead = false;
        this.revive_timer = new timer();
        this.revive_time = 60000;
        this.revivable_sound = true;
        this.low_health = false;
        this.inventory = new Inventory(this.server, this);
        this.hp = hp;
        this.speed_cola = false;
        this.reply_list = [];
        this.typing = false;
        this.typing_timer = new timer();
        this.health_timer = new timer();
        this.invisible = false;
        this.total_shots = 0;
        this.total_hits = 0;
        this.weapon_manager = new weapon_manager(server, this);
        this.perks = new PerkManager(server, this);
        this.reset_to_defaults();
        this.change_map(this.server.maps["main"], 0, 0, 0);
    }
    reset_to_defaults() {
        this.send(
            consts.channel_misc,
            "has_radio_self",
            {"enable": false}
        );
        this.map.send(
            consts.channel_misc,
            "has_radio",
            {
                "channel": this.voice_channel,
                "enable": false
            }
        );
        this.perks.clear(true);
        this.being_hit = false;
        if (this.dead) this.revive(true);
        this.revive_timer = new timer();
        this.revive_time = 60000;
        this.revivable_sound = true;
        this.low_health = false;
        this.inventory.clear();
        this.weapon_manager.clear();
        this.weapon_manager.add(
            this.server.make_weapon({ owner: this, name: "knife" })
        );
        this.weapon_manager.add(
            this.server.make_weapon({
                owner: this,
                name: "357_magnum_revolver",
            })
        );
        this.weapon_manager.add(
            this.server.make_weapon({ owner: this, name: "mp7" })
        );
    }
    get contributor(): boolean {
        return this.isContributor;
    }
    get moderator(): boolean {
        return this.contributor || this.user.moderator;
    }
    get builder(): boolean {
        return this.moderator || this.user.builder;
    }
    send(
        channel: number,
        event: string,
        data: Record<string, any> = {},
        reliable = true
    ): void {
        this.server.send(this.peer, channel, event, data, reliable);
    }
    play_direct(
        sound: string,
        looping = false,
        volume = 100,
        streaming = false,
        others = false,
        id = ""
    ): void {
        this.send(consts.channel_sound, "play_direct", {
            sound: sound,
            looping: looping,
            volume: volume,
            streaming: streaming,
            id: id,
        });
        if (others) {
            this.play_sound(sound, looping, volume, streaming, true);
        }
    }
    play_unbound(
        sound: string,
        x: number,
        y: number,
        z: number,
        volume = 100,
        streaming = false
    ): void {
        this.send(consts.channel_sound, "play_unbound", {
            sound: sound,
            x: x,
            y: y,
            z: z,
            volume: volume,
            streaming: streaming,
        });
    }
    speak(text: string, interupt = true, buffer = "", sound = ""): void {
        this.send(consts.channel_speech, "speak", {
            text: text,
            interupt: interupt,
            buffer: buffer,
            sound: sound,
        });
    }
    chat(message: string): void {
        if (this.language_channel && !this.user.muted && this.chat_timer.elapsed >= 1500) {
            this.chat_timer.restart();
            this.language_channel.send(`${this.user.nickname}: ${message}`, this);
            var title = ""
            if (this.server.authorised_names.includes(this.user.username.toLowerCase())) title = "(Beta Tester)";
            if (this.isContributor) title = "(Contributor)"
            this.server.discord.send_message(
                message,
                channel_id.gamechat,
                `${this.user.username} ${title}`
            );
            this.user.log_chat("chat", message);
        }   
    }
    emote(message: string): void {
        if (this.language_channel) {
            this.language_channel.send(`*${this.user.nickname} ${message}`, this);
            this.user.log_chat("chat", `/me ${message}`);
            this.server.discord.send_message(
                `${this.user.nickname} ${message}`,
                channel_id.gamechat,
                "emote"
            );
        }
    }
    send_pm(target: Player, message: string): void {
        if (this.user.block_list.includes(target.user.username)) {
            this.speak("You are blocked by this player");
            return;
        }
        target.speak(
            `tell from ${this.user.nickname} (${this.name}). ${message}`,
            true,
            "tell",
            "ui/pm.ogg"
        );
        this.speak(
            `tell to ${target.user.nickname} (${target.name}). ${message}`,
            true,
            "tell",
            "ui/pm.ogg"
        );
        for (let i = 0; i < target.reply_list.length; i++) {
            if (target.reply_list[i][0] == this.user.username) {
                target.reply_list.splice(i, 1);
            }
        }
        target.reply_list.push([
            this.user.username,
            this.user.username + "'s message: " + message,
        ]);
        for (let i = 0; i < this.reply_list.length; i++) {
            if (this.reply_list[i][0] == target.user.username) {
                this.reply_list.splice(i, 1);
            }
        }
        this.reply_list.push([
            target.user.username,
            "Your message: " + message,
        ]);
        this.user.log({
            eventType: "tell",
            eventData: {
                sender: this.user.username,
                receiver: target.user.username,
                message: message,
            },
        });
    }
    send_pmmod(target: Player, message: string) {
        target.speak(
            `tell from a moderator. ${message}`,
            true,
            "tell",
            "ui/pm.ogg"
        );
        this.speak(
            `moderator tell to ${target.name}. ${message}`,
            true,
            "tell",
            "ui/pm.ogg"
        );
        this.server.speakmods(
            `${this.user.username} just sent a moderator to tell ${target.user.username}: ${message} `,
            false,
            "staff",
            "ui/notify2.ogg"
        );
        this.user.log({
            eventType: "tellmod",
            eventData: {
                sender: this.user.username,
                receiver: target.user.username,
                message: message,
            },
        });
    }
    save(): Promise<User> {
        return this.user.save();
    }
    destroy(): void {
        if (this.game) this.game.remove_player(this);
        super.destroy();
        this.peer.disconnect();
        if (this.language_channel) {
            this.language_channel.remove_player(this);
        }
    }
    create_inventory(): void {
        if (!this.inventory) {
            this.inventory = new Inventory(this.server, this);
        }
    }
    set_hp(amount: number, obj?: Game_object) {
        if (amount <= this.maxHp && amount > 0) {
            this.hp = amount;
            this.send(consts.channel_misc, "set_hp", { amount: amount });
        } else if (amount <= 0) {
            this.kill(obj);
            this.send(consts.channel_misc, "set_hp", { amount: 0 });
        } else if (amount > this.maxHp) {
            this.hp = this.maxHp;
            this.send(consts.channel_misc, "set_hp", { amount: this.maxHp });
        }
    }
    revive(silent = false): void {
        this.quick_revive = false;
        if (
            (this.dead && this.revive_timer.elapsed >= this.revive_time) ||
            (this.dead && silent)
        ) {
            this.dead = false;
            this.send(consts.channel_misc, "death", { dead: false });
            this.set_hp(this.maxHp);
            if (!silent && this.game) {
                if (this.character) this.character.play_sound("revive", 1);
                this.game.speak(`${this.name} Was revived`);
            }
            this.revive_time = 60000;
        }
    }
    get points(): number {
        if (this.game && this.game.zomby_game)
            return this.game.scores[this.name].points;
        else return 0;
    }
    set points(value: number) {
        if (this.game && this.game.zomby_game) {
            this.game.scores[this.name].points = value;
        }
    }
    get high_points(): number {
        return this.user.high_points;
    }
    set high_points(value: number) {
        this.user.high_points = value;
    }
    get high_kills(): number {
        return this.user.high_kills;
    }
    set high_kills(value: number) {
        this.user.high_kills = value;
    }
    get high_accuracy(): number {
        return this.user.high_accuracy;
    }
    set high_accuracy(value: number) {
        this.user.high_accuracy = value;
    }
    get accuracy(): number {
        if (this.game && this.game.zomby_game) {
            return this.game.scores[this.name].accuracy;
        } else return 0;
    }
    set accuracy(value: number) {
        if (this.game && this.game.zomby_game)
            this.game.scores[this.name].accuracy = value;
    }
    get kills(): number {
        if (this.game) return this.game.scores[this.name].kills;
        else return 0;
    }
    kill(obj?: Game_object) {
        if (!this.game || !this.game.started) return this.set_hp(this.maxHp);
        if (this.low_health) {
            this.low_health = false;
            this.stop_low_health_sound();
        }
        this.send(consts.channel_misc, "death", { dead: true });
        if (this.character) this.character.play_sound("death", 1);
        this.dead = true;
        this.perks.clear(true);
        this.revivable_sound = false;
        this.revive_timer.restart();
        if (
            this.game &&
            this.game.get_dead_players() >= this.game.players.size
        ) {
            if (this.game.players.size > 1 || this.revive_time == 60000)
                return this.game.end();
        }
        this.game.speak(
            `${this.user.username} just died!`,
            false,
            "match",
            "death/other.ogg",
            [this.name]
        );
    }
    on_hit(object: Game_object, hp?: number, excludeme?: boolean): void {
        if (object instanceof Zomby || object instanceof Grenade_entity) {
            if (!this.dead) this.set_hp(this.hp - (hp ?? 0), object);
        }
    }
    main_menu(): void {
        const m = new menu(this.server, "Main menu", "mainmenu");
        if (!this.game) {
            m.add_option("Create a new match", { action: "create" });
            m.add_option("Join a match", { action: "join" });
            m.add_option("view the leaderboard", { action: "leaderboard" });
        } else {
            m.add_option("Speak joined players", { action: "who_in" }, false);
            if (this.game.owner === this) {
                if (!this.game.started) {
                    m.add_option("Start the match", { action: "start" });
                }
                m.add_option("Destroy the match", { action: "destroy" });
            }
            if (this.game.owner != this && !this.game.started)
                m.add_option("Leave the match", { action: "leave" });
        }
        m.send(this.peer);
    }
    private _creatingGame = false;
    async create_match(mapname: string): Promise<zomby_game> {
        if (!this.game && !this._creatingGame) {
            this._creatingGame = true;
            var game_map = await WorldMap.compileMapFromFile(
                this.server,
                `maps/${mapname}.map`
            );
            var the_game = new zomby_game(
                this.server,
                this,
                `Zombies match created by ${this.name} on map ${mapname}`,
                game_map
            );
            this.server.speak_unbound(
                `${this.name} has created a zombies game using the map ${mapname}`,
                false,
                "main"
            );
            this._creatingGame = false;
            this.user.log({
                eventType: "match_create",
                eventData: {
                    name: the_game.name,
                    player_count: the_game.players.size - 1,
                },
            });
            return the_game;
        }
        throw new Error("Already in a game");
    }
    join_match(name: string): void {
        var game = this.server.get_game_by_name(name);
        if (!this.game && game && !game.started) {
            game.add_player(this);
            this.change_map(this.server.maps[game.map.mapName]);
            this.speak("You are in exploration mode", true, "match");
            this.user.log({
                eventType: "match_join",
                eventData: {
                    name: game.name,
                    player_count: game.players.size - 1,
                },
            });
        } else {
            this.speak("This match has already been started.");
        }
    }
    players_in_radius(radius: number): string[] {
        var in_radius: string[] = [];
        var colliding = this.map.playersQuadtree.colliding({
            x: this.x - radius,
            y: this.y - radius,
            width: radius * 2 + 1,
            height: radius * 2 + 1,
        });
        for (let i of colliding) {
            if (i != this) {
                var delta_x = i.x - this.x;
                var delta_y = i.y - this.y;
                var delta_z = i.z - this.z;
                var horizontal = delta_x ** 2 + delta_y ** 2;
                var square_distance = horizontal + delta_z ** 2;
                if (square_distance <= radius ** 2) {
                    in_radius.push(i.user.username);
                }
            }
        }
        return in_radius;
    }
    toggle_invis(): void {
        if (this.contributor) {
            if (this.user.invisible == false) {
                this.user.invisible = true;
                this.speak(
                    "You have enabled your invisibility, you're online and offlines will now be muted, make sure you're using then when testing feature that require you to flash a lot"
                );
                this.server.speakmods(
                    `${this.user.username} has enabled their invisibility. `,
                    false,
                    "staff",
                    "ui/notify2.ogg"
                );
                this.server.send_all(consts.channel_misc, "offline", {
                    username: this.user.username,
                });
                this.change_map(this.server.maps["developer_land"], 0, 0, 0);
            } else if (this.user.invisible == true) {
                this.user.invisible = false;
                this.speak("You've disabled your invisibility");
                this.server.speakmods(
                    `${this.user.username} has disabled their invisibility. `,
                    false,
                    "staff",
                    "ui/notify2.ogg"
                );
                this.server.send_all(consts.channel_misc, "online", {
                    username: this.user.username,
                });
                this.change_map(this.server.maps["main"], 0, 0, 0);
            }
        }
    }
    change_map(map: map, x?: number, y?: number, z?: number): void {
        this.reset_to_defaults();
        this.send(consts.channel_map, "update_mumble_context", {
            context: map.mapName,
        });
        super.change_map(map, x, y, z);
    }
    async loop(): Promise<void> {
        await super.loop();
        if (
            this.game &&
            this.weapon_manager.active_weapon?.ammo == 0 &&
            !this.weapon_manager.active_weapon.melee &&
            this.reload_voice
        ) {
            this.character?.play_sound("ammo_out");
            this.reload_voice = false;
        } else if (
            this.weapon_manager.active_weapon?.ammo != 0 &&
            !this.reload_voice
        )
            this.reload_voice = true;
        // health regeneration
        if (this.health_timer.elapsed > random.random_number(2000, 4000)) {
            this.health_timer.restart();
            if (!this.dead && this.hp < this.maxHp) {
                this.set_hp(this.hp + 1);
            }
        }
        //revive sound
        if (this.quick_revive == true && this.revive_time == 60000)
            this.revive_time = 30000;

        if (
            this.dead &&
            this.revive_timer.elapsed >= this.revive_time &&
            !this.revivable_sound
        ) {
            this.revivable_sound = true;
            if (this.game) {
                for (let i of this.game.players) {
                    i.speak(
                        `${
                            this.name
                        } can now be revived, they're at ${Math.trunc(
                            this.x
                        )}, ${Math.trunc(this.y)}, ${Math.trunc(this.z)}`,
                        true,
                        "match",
                        "death/timer_up.ogg"
                    );
                }
            }
        }
        if (!this.dead && this.hp <= 20 && !this.low_health) {
            this.low_health = true;
            this.start_low_health_sound();
        } else if (this.hp > 20 && this.low_health) {
            this.low_health = false;
            this.stop_low_health_sound();
        }
    }
    on_interact(
        interactor: Game_object,
        angle: number,
        pitch: number
    ): boolean {
        if (
            interactor.name != this.name ||
            (this.revive_time == 30000 &&
                this.game?.players.size == 1 &&
                this.dead)
        ) {
            if (this.revive_timer.elapsed >= this.revive_time) this.revive();
            return true;
        }
        return false;
    }
    start_low_health_sound() {
        this.play_direct(
            "death/heartbeat.ogg",
            true,
            100,
            false,
            false,
            "low_health"
        );
    }
    stop_low_health_sound() {
        this.play_direct(
            "death/heartbeat.ogg",
            false,
            0,
            false,
            false,
            "low_health"
        );
    }
}

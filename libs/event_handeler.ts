import bcrypt from "bcrypt";
import Player from "./objects/player";
import consts from "./consts";
import channel_id from "./channel_id";
import fs from "fs/promises";
import * as file from "./file";
import menu from "./menu";
import inventory from "./inventory";
import Item from "./items/item";
import Grenade from "./items/grenade";
import grappler from "./items/grappler";
import { to_num } from "./string_utils";
import * as string_utils from "./string_utils";
import { random_number } from "./random";
import Server from "./networking";
import WorldMap from "./world_map";
import Grappler_item from "./items/grappler";
import Grenade_item from "./items/grenade";
import Window from "./objects/window";
import Weapon from "./weapon";
import Grenade_entity from "./objects/grenade";
import parse_log_query from "./log_query_parser";
import Log from "./database/models/log";
import { logged_entry_to_string } from "./utils";
import {
    parseBehaviorTreeNode,
    parseBehaviorTreeXml,
} from "./behavior_tree/parser";
import Blackboard from "./behavior_tree/blackboard";
import Zomby_game from "./zomby_game";
import { get_distance } from "./movement";
import User from "./database/models/player";
import IPBan from "./database/models/ipbans";

type EventCallback = (
    this: Event_handeler,
    peer: any,
    data: Record<string, any>
) => void | Promise<void>;

export default class Event_handeler {
    server: Server;
    constructor(server: Server) {
        this.server = server;
    }
    async disconnect(peer: any) {
        var player = this.server.get_by_peer(peer);
        if (!player) return;
        if (player) {
            player.user.log({
                eventType: "logout",
                eventData: { invisible: player.user.invisible },
            });
            this.server.send_all(consts.channel_misc, "offline", {
                username: player.user.username,
            });
            this.server.remove_player(player);
            await player.save();
            player.destroy();
        }
    }
    private static readonly USERNAME_RE = /^[a-zA-Z0-9_\-]{3,32}$/;
    private static readonly MIN_PASSWORD_LEN = 6;

    private validate_username(peer: any, data: any): boolean {
        const username: string = typeof data?.username === "string" ? data.username : "";
        if (!Event_handeler.USERNAME_RE.test(username)) {
            this.server.send(peer, consts.channel_misc, "login_failed", { message: "Invalid username." });
            return false;
        }
        return true;
    }

    private validate_credentials(peer: any, data: any): boolean {
        if (!this.validate_username(peer, data)) return false;
        const password: string = typeof data?.password === "string" ? data.password : "";
        if (password.length < Event_handeler.MIN_PASSWORD_LEN) {
            this.server.send(peer, consts.channel_misc, "login_failed", { message: "Password too short." });
            return false;
        }
        return true;
    }

    events: Record<string, EventCallback> = {
        async create(peer, data) {
            var server = this.server;
            if (!this.validate_credentials(peer, data)) return;
            const normalized_username = data["username"].toLowerCase();
            const ban = await this.server.database.IPBans.findOne({
                where: { IP: peer.address().address }
            });
            if (ban != null) {
                if (ban.permban) {
                    this.server.send(peer, consts.channel_misc, "ban", {
                        message: `This IP address has been banned. \r\nAddress: ${ban.IP}\r\nReason: ${ban.reason}`
                    });
                    return;
                } else if (ban.tempban && Date.now() >= ban.expiryDate) {
                    this.server.send(peer, consts.channel_misc, "ban", {
                        message: `This IP address has been banned.\r\nAddress: ${ban.IP}\r\nExpiry Date: ${new Date(ban.expiryDate).toString()}\r\nReason: ${ban.reason}`
                    });
                    return;
                }
            }
            //if (!this.server.authorised_names.includes(normalized_username)) {
                //return this.server.send(
                    //peer,
                    //consts.channel_misc,
                    //"authorisation_fail",
                    //{}
                //);
            //}
            let exists = await this.server.database.users.username_exists(
                data.username
            );
            if (exists) {
                return server.send(
                    peer,
                    consts.channel_misc,
                    "create_fail",
                    {}
                );
            } else {
                let password = await bcrypt.hash(
                    data.password,
                    consts.hash_rounds
                );
                const username = data.username as string;
                const user = await this.server.database.users.create({
                    username: username,
                    nickname: data.username as string,
                    password: password,
                    normalized_username: username.toLowerCase(),
                });
                await user.log({
                    eventType: "account_created",
                    eventData: null,
                });
                server.send(peer, consts.channel_misc, "create_done", {});
            }
        },
        async login(peer, data) {
            var server = this.server;
            if (!this.validate_username(peer, data)) return;
            if (server.updating) {
                server.send(peer, consts.channel_misc, "login_failed", {
                    message: "the server is updating",
                });
                return;
            }
            const normalized_username = data["username"].toLowerCase();
            //if (!this.server.authorised_names.includes(normalized_username)) {
                //server.send(peer, consts.channel_misc, "login_failed", {
                    //message: "name not in white list",
                //});
                //return;
            //}
            if (this.server.get_by_username(data["username"])) {
                //user already logged in.
                return this.server.send(
                    peer,
                    consts.channel_misc,
                    "login_failed",
                    {
                        message: "user already logged in",
                    }
                );
            }
            let exists = await this.server.database.users.username_exists(
                data.username
            );
            if (exists) {
                let user = await this.server.database.users.get_by_username(
                    data.username
                );
                let result = await bcrypt.compare(data.password, user.password);
                if (result) {
                    //password match.
                    if (user.permban) {
                        this.server.send(peer, consts.channel_misc, "ban", {
                            message: `This user has been banned.\r\nReason: ${user.banReason}`
                        });
                        if (user.IPBans.length > 0 && !user.IPList.includes(peer.address().address)) {
                            const banInfo = await this.server.database.IPBans.findOne({ where: { IP: user.IPBans[0]}});
                            var newBan = await this.server.database.IPBans.create({
                                IP: peer.address().address,
                                permban: banInfo?.permban,
                                tempban: banInfo?.tempban,
                                expiryDate: banInfo?.expiryDate,
                                reason: banInfo?.reason
                            });
                            user.IPBans = user.IPBans.concat([newBan.IP]);
                            user.IPList = user.IPList.concat([newBan.IP]);
                            await newBan.save();

                        }
                        return;
                    }
                    const ban = await this.server.database.IPBans.findOne({
                        where: { IP: peer.address().address }
                    });
                    if (ban != null) {
                        if (ban.permban) {
                            this.server.send(peer, consts.channel_misc, "ban", {
                                message: `This IP address has been banned. \r\nAddress: ${ban.IP}\r\nReason: ${ban.reason}`
                            });
                            return;
                        } else if (ban.tempban && Date.now() <= ban.expiryDate) {
                            this.server.send(peer, consts.channel_misc, "ban", {
                                message: `This IP address has been banned.\r\nAddress: ${ban.IP}\r\nExpiry Date: ${new Date(ban.expiryDate).toString()}\r\nReason: ${ban.reason}`
                            });
                            return;
                        } else if (ban.tempban && Date.now() > ban.expiryDate) {
                            this.server.speakmods(`The tempban on ${ban.IP} has expired and an account is logging in from that IP`, true, "staff", "ui/notify2.ogg");
                            await ban.destroy();
                        }
                    }
                    this.server.send(peer, consts.channel_misc, "connected", {
                        username: user.username,
                    });
                    //load the player from the configuration file
                    let player = new Player({
                        server: server,
                        peer: peer,
                        user: user,
                        map: server.maps["main"],
                        language_channel_name: "english",
                    });
                    if (player.user.nickname == null)
                        player.user.nickname = player.user.username;
                    const message = await fs.readFile("./sm.txt");
                    player.speak("Server Message: " + message, false, "main");
                    if (this.server.contributors.includes(player.name)) {
                        player.isContributor = true;
                        player.speak(
                            "You are able to use contributor-only features. Please use them wisely.",
                            false,
                            "staff"
                        );
                        this.server.speak(`${player.user.username} is a contributor. `, false, "main");
                    }
                    if (this.server.authorised_names.includes(normalized_username)) {
                        this.server.speak(`${player.user.username} was a beta tester.`, false, "main");
                    }
                    if (player.user.off_msg_queue.length > 0) {
                        for (let i of player.user.off_msg_queue) {
                            player.speak(i[0], i[1], i[2], i[3]);
                        }
                        player.user.off_msg_queue = [];
                        player.user.save();
                    }
                    player.user.log({
                        eventType: "login",
                        eventData: { invisible: player.user.invisible },
                    });
                    if (!player.user.invisible) {
                        server.send_all(consts.channel_misc, "online", {
                            username: user.username,
                        });
                    } else {
                        this.server.speakmods(
                            `${player.user.username} just came online invisibly.`,
                            false,
                            "staff",
                            "ui/notify2.ogg"
                        );
                        player.change_map(
                            this.server.maps["developer_land"],
                            0,
                            0,
                            0
                        );
                    }
                    server.add_player(player);
                    this.server.discord.update(
                        `${this.server.players.length} players online and ${this.server.games.length} matches`
                    );
                } else {
                    //password does not match.
                    this.server.send(
                        peer,
                        consts.channel_misc,
                        "login_fail",
                        {}
                    );
                }
            } else {
                // user does not exist
                this.server.send(peer, consts.channel_misc, "login_fail", {});
            }
        },
        stats(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.game && player.game.started) {
                if (player.game instanceof Zomby_game) {
                    player.speak(
                        `${player.points} points and ${
                        player.kills
                        } kills with an accuracy of ${player.accuracy ?? 0}%. There are ${Math.round(player.game.calculate_zombies_amount(player.game.round) - player.game.killed_zombies)} remaining zombies to kill. `
                    );
                } else {
                    player.speak(
                        `${player.points} points and ${
                        player.kills
                        } kills with an accuracy of ${player.accuracy ?? 0}%`
                    );
                }
            }
        },
        async logout(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player) {
                this.server.remove_player(player);
                player.user.log({
                    eventType: "logout",
                    eventData: { invisible: player.user.invisible },
                });
                if (!player.user.invisible) {
                    this.server.send_all(consts.channel_misc, "offline", {
                        username: player.user.username,
                    });
                } else if (player.user.invisible) {
                    this.server.speakmods(
                        `${player.user.username} just went offline invisibly. `,
                        false,
                        "staff",
                        "ui/notify2.ogg"
                    );
                }
                if (data["message"]) {
                    player.send(consts.channel_misc, "quit", {
                        "message": "Logging out. "
                    });
                } else {
                    player.send(consts.channel_misc, "quit", {});
                }

                await player.save();
                player.destroy();
                this.server.discord.update(
                    `${this.server.players.length} players online and ${this.server.games.length} matches`
                );
            }
        },
        async voice_chat(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.user.muted) return;
            var exclude = [player.name];
            for (let i of player.user.block_list) exclude.push(i);
player.map.send(player.voice_channel, "n/a", data, exclude);
        },
        async chat(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player) {
                var message = data.message.trim();
                if (message.startsWith("/")) {
                    //the message is a slash command.
                    try {
                        await this.handel_command(player, message);
                    } catch (err) {
                        player.speak("Error");
                        if (err instanceof Error && player.contributor)
                            player.speak(err.toString());
                        console.log(err);
                    }
                    return;
                }
                player.chat(data.message);
            }
        },
        async map_chat(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player || player && player.user.muted) return;
            if (player) {
                var message = data["message"].trim();
                if (message.startsWith("/")) {
                    //the message is a slash command.
                    try {
                        await this.handel_command(player, message);
                    } catch (err) {
                        player.speak("Error");
                        if (err instanceof Error && player.contributor)
                            player.speak(err.toString());
                        console.log(err);
                    }
                    return;
                }
                player.map.playersQuadtree.each((i) => {
                    if (player instanceof Player && player.user.block_list.includes(i.user.username)) return;
                    else i.speak(
                        `map - ${player?.name}: ${message}`,
                        true,
                        "map chat"
                    );
                    if (i != player) i.play_sound("ui/mapchat.ogg", false, 50);
                });
                player.user.log_chat("map_chat", message);
            }
        },
        ping(peer, data) {
            this.server.send(peer, consts.channel_ping, "ping", {});
        },
        who_online(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player) {
                var players_list: Player[] = [];
                for (let i of this.server.players) {
                    if (!i.user.invisible || player.moderator) {
                        players_list.push(i);
                    }
                }
                var online = string_utils.array_to_string(
                    players_list.map((player) => player.user.username),
                    `${players_list.length} Online players: `,
                    "You are all alone. How sad!"
                );
                player.speak(online, true, "main");
            }
        },
        who_online_m(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player) {
                var players_list: Player[] = [];
                for (let i of this.server.players) {
                    if (!i.user.invisible || player.moderator) {
                        players_list.push(i);
                    }
                }
                if (players_list.length == 1) {
                    player.speak("You're all alone, how sad", true, "main");
                } else {
                    var m = new menu(this.server, "Players menu", "copy_menu");
                    for (let i of this.server.players) {
                        if (i.user.invisible == true && player.moderator) {
                            if (i.typing == true) {
                                m.add_option(
                                    i.user.username +
                                        "(" +
                                        i.user.nickname +
                                        ")" +
                                        " (invisible and typing...) on " +
                                        i.map.mapName,
                                    i.user.username
                                );
                            } else if (i.typing == false) {
                                m.add_option(
                                    i.user.username +
                                        " (" +
                                        i.user.nickname +
                                        ") (invisible...) on " +
                                        i.map.mapName,
                                    i.user.username
                                );
                            }
                        } else if (i.user.invisible == false) {
                            if (i.typing == true) {
                                m.add_option(
                                    i.user.username +
                                        " (" +
                                        i.user.nickname +
                                        ") (typing...) on " +
                                        i.map.mapName,
                                    i.user.username
                                );
                            } else if (i.typing == false) {
                                m.add_option(
                                    i.user.username +
                                        " (" +
                                        i.user.nickname +
                                        ") on " +
                                        i.map.mapName,
                                    i.user.username
                                );
                            }
                        }
                    }
                    m.send(player.peer);
                }
            }
        },
        leaderboard_menu(peer, data) {
            var data = data["value"] as Record<string, any>;
            switch (data["action"]) {
                case "kills":
                    this.server.leaderboard.get_kills_leaderboard(peer);
                    break;
                case "points":
                    this.server.leaderboard.get_points_leaderboard(peer);
                    break;
                case "accuracy":
                    this.server.leaderboard.get_accuracy_leaderboard(peer);
                    break;
            }
        },
        async mainmenu(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            data = data.value;
            switch (data.action) {
                case "leaderboard":
                    var m = new menu(
                        this.server,
                        "leaderboard list",
                        "leaderboard_menu"
                    );
                    m.add_option("kills", { action: "kills" }, true);
                    m.add_option("points", { action: "points" }, true);
                    m.add_option("accuracy", { action: "accuracy" }, true);
                    m.send(player.peer);
                    break;
                case "create":
                    // in case there is no map given, send a menu with the available maps.
                    if (!data.map) {
                        var maps_menu = new menu(
                            this.server,
                            "Choose a map",
                            "mainmenu"
                        );
                        for (let i of Object.values<WorldMap>(
                            this.server.maps
                        )) {
                            if (i.public_ || player.builder) {
                                var message: string;
                                if (i.public_ && player.builder) message = " (published)";
                                else if (i.public_ && !player.builder) message ="";
                                else if (!i.public_ && player.builder) message = " (unpublished)";
                                else break;
                                maps_menu.add_option(`${i.mapName}${message}`, {
                                    action: "create",
                                    map: i.mapName,
                                });
                            }
                        }
                        maps_menu.send(peer);
                    } else {
                        //a map is given
                        player.speak("Loading map, please wait.", true, "match");
                        await player.create_match(data.map);
                        player.change_map(this.server.maps[data.map]);
                        player.speak(
                            "You are in exploration mode",
                            true,
                            "match"
                        );
                    }
                    break;
                case "join":
                    var playable_game = false;
                    for (let i of this.server.games) {
                        if (!i.started && !player.user.block_list.includes(i.owner.user.username) || !i.started && !i.owner.user.block_list.includes(player.user.username)) {
                            playable_game = true;
                            break;
                        }
                    }
                    if (!this.server.games.length || !playable_game)
                        return player.speak("No games available");
                    // in case there is no game given, send a menu with the available games.
                    if (!data.game) {
                        var games_menu = new menu(
                            this.server,
                            "Choose a match",
                            "mainmenu"
                        );
                        for (let i of this.server.games) {
                            if (
                                !i.started &&
                                i.public_ &&
                                i.players.size < i.max_players
                            ) {
                                if (player.user.block_list.includes(i.owner.user.username) || i.owner.user.block_list.includes(player.user.username)) continue; 
                                else games_menu.add_option(i.name, {
                                    action: "join",
                                    game: i.name,
                                });
                            }
                        }
                        games_menu.send(peer);
                    } else {
                        //a game is given
                        player.join_match(data.game);
                    }
                    break;
                case "who_in":
                    if (player.game)
                        player.speak(
                            string_utils.array_to_string(
                                Array.from(player.game.players).map(
                                    (player) => player.name
                                ),
                                "Players: ",
                                "Only you"
                            )
                        );
                    break;
                case "start":
                    if (player === player.game?.owner) player.game.start();
                    break;
                case "destroy":
                    if (player === player.game?.owner) {
                        player.user.log({
                            eventType: "match_destroy",
                            eventData: {
                                name: player.game.name,
                                player_count: player.game.players.size - 1,
                            },
                        });
                        if (!player.game.started) {
                            for (let i of player.game?.players)
                                i.change_map(this.server.maps["main"]);
                        }
                        player.game.destroy();
                    }
                    break;
                case "leave":
                    if (player.game)
                        player.user.log({
                            eventType: "match_leave",
                            eventData: {
                                name: player.game.name,
                                player_count: player.game.players.size - 1,
                            },
                        });
                    if (!player.game?.started)
                        player.change_map(this.server.maps["main"]);
                    player.game?.remove_player(player);
                    break;
            }
        },
        copy_menu_lb(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.send(consts.channel_misc, "copy", {
                data: data["value"],
                message: "copied to clipboard",
            });
            if (data.value.startsWith("15:")) {
                player.play_direct(
                    "server_sounds:server_sounds/foot_lettus.ogg",
                    false,
                    100
                );
                player.speak(
                    "Congratulations, you just found final hour's first easter egg!"
                );
            }
        },
        copy_menu(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.send(consts.channel_misc, "copy", {
                data: data["value"],
                message: "copied to clipboard",
            });
        },
        async server_message(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            const message =
                "Server Message: " + (await fs.readFile("./sm.txt"));
            player.speak(message, false, "main");
        },
        move(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            const x = data["x"], y = data["y"], z = data["z"];
            if (!player.map.in_bound(x, y, z)) return;
            player.move(x, y, z, data["play_sound"], data["mode"], true, data["angle"]);
        },
        change_map(peer, data) {
            const player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.builder) {
                const _map = this.server.maps[data.value];
                if (_map) {
                    player.change_map(_map);
                }
            }
        },
        open_builder(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.builder || player.moderator || player.contributor) {
                player.send(consts.channel_map, "open_builder", {});
            }
        },
        open_drop_menu(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.create_inventory();
            if (player.inventory.items.length <= 0) return player.speak("You have no items to give");
            else if (player.players_in_radius(5).length <= 0) return player.speak("There is noone close enough to give items to.");
            var drop_menu = new menu(
                this.server,
                "Who would you like to give items to?",
                "donate_item"
            );
            for (let target of player.players_in_radius(5)) {
                drop_menu.add_option(`${target}`, {action: target}, true);
            }
            drop_menu.send(peer);
        },
        donate_item(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            data = data.value;
            var donate_menu = new menu(
                this.server,
                `Which item would you like to give to ${data.action}`,
                "donate_amount"
            );
            for (let item of player.inventory.items) {
                donate_menu.add_option(`${item.name}: ${item.amount}`, {action: item.name, target: data.action}, true);
            }
            donate_menu.send(peer);
        },
        donate_amount(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.send(
                consts.channel_menus,
                "make_input",
                {
                    event: "donate",
                    prompt: "Enter the number of the items you would like to donate.",
                    data: {
                        itemname: data.value.action,
                        target: data.value.target
                    }
                }
            );
        },
        donate(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            var target = this.server.get_by_username(data.data.target);
            if (!target) return;
            var itemname = data.data.itemname;
            var amount = to_num(data.value.trim());
            var item = player.inventory.find_item(itemname);
            if (item == null) {
                player.speak("You don't have this item");
                return;
            } else if (item.amount < amount) {
                player.speak("You don't have enough of this item");
                return;
            } else if (amount <= 0) {
                player.speak("You can't give fewer than 1 item to someone");
                return;
            } else if (get_distance(
                {
                    x: player.x,
                    y: player.y,
                    z: player.z
                },
                {
                    x: target.x,
                    y: target.y,
                    z: target.z
                }
            ) > 5) {
                player.speak("You are too far away");
                return;
            }
            switch (itemname) {
                case "frag_grenade":
                    target.inventory.add_item(
                        new Grenade(
                            this.server,
                            target,
                            amount,
                            "frag_grenade",
                            "a frag grenade",
                            30,
                            9,
                            random_number(3000, 5000)
                        )
                    );
                    player.inventory.take_item("frag_grenade", amount);
                    break;
                case "radio":
                    target.inventory.add_item(new Item(
                        this.server,
                        target,
                        amount,
                        "radio",
                        "a radio",
                        0
                    ));
                    player.inventory.take_item(
                        "radio", amount
                    );
                    target.send(
                        consts.channel_misc,
                        "has_radio_self",
                        {
                            "enable": true
                        }
                    );
                    target.map.send(
                        consts.channel_misc,
                        "has_radio",
                        {
                            "channel": target.voice_channel,
                            "enable": true
                        }
                    );
                    if (!player.inventory.find_item("radio")) {
                        player.send(
                            consts.channel_misc,
                            "has_radio_self",
                            {
                                "enable": false
                            }
                        );
                        player.map.send(
                            consts.channel_misc,
                            "has_radio",
                            {
                                "channel": player.voice_channel,
                                "enable": false
                            }
                        );    
                    }
                    break;
                default:
                    target.inventory.add_item(
                        new Item(
                            this.server,
                            target,
                            amount,
                            itemname
                        )
                    );
                    player.inventory.take_item(
                        itemname,
                        amount
                    );
                    break;
            }
            player.speak(
                `You just handed ${amount} ${itemname} to ${target?.name}`,
                true,
                "players",
            );
            player.play_sound(
                "items/give.ogg",
            );
            target?.speak(
                `${player.name} just handed ${amount} ${itemname}s to you.`,
                true,
                "players",
            );
            target.play_sound(
                "items/recieve.ogg"
            );


        },
        open_inventory(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.create_inventory();
            if (player.inventory.items.length < 1) {
                player.speak("empty");
            } else {
                var inv_menu = new menu(
                    this.server,
                    "your inventory",
                    "select_item"
                );
                for (let i of player.inventory.items) {
                    inv_menu.add_option(i.name + ": " + i.amount, i.name);
                }
                inv_menu.send(player.peer);
            }
        },
        select_item(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            var item = player.inventory.find_item(data["value"]);
            if (item) {
                item.action_1();
                player.inventory.take_item(item.name, item.use_amount);
            }
        },
        get_hp(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.speak(
                player.dead
                    ? "You're dead"
                    : `${player.hp} of ${player.maxHp} HP`
            );
        },
        set_hp(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player || !player.builder) return;
            var amount = to_num(data["amount"]);
            player.set_hp(amount);
        },
        async send_reply(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            var target = this.server.get_by_username(data["value"][0]);
            if (target) {
                player.send_pm(target, data["value"][1]);
            } else if (
                await this.server.database.users.username_exists(
                    data["value"][0]
                )
            ) {
                this.server.offline_speak(
                    data["value"][0],
                    "offline tell from " +
                        player.user.username +
                        ": " +
                        data["value"][1],
                    true,
                    "tell",
                    "ui/pm.ogg"
                );
                player.speak(
                    "Offline tell to " +
                        data["value"][0] +
                        ": " +
                        data["value"][1],
                    true,
                    "tell",
                    "ui/pm.ogg"
                );
            }
        },
        set_typing(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (data["typing"] == true) {
                player.typing = true;
                if (player.typing_timer.elapsed >= 6000) {
                    this.server.send_all(consts.channel_misc, "typing", {
                        message: `${player.user.username} is typing. `,
                    });
                    player.typing_timer.restart();
                }
            } else if (data["typing"] == false) {
                player.typing = false;
            }
        },
        interact(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.dead && player.revive_time == 30000)
                player.on_interact(player, data.angle, data.pitch);
            if (!player.dead) {
                const reviver = player;
                let revived_someone = false;
                reviver.map.playersQuadtree.each((other) => {
                    if (
                        !revived_someone &&
                        other !== reviver &&
                        other instanceof Player &&
                        other.dead &&
                        Math.abs(other.x - reviver.x) <= 1 &&
                        Math.abs(other.y - reviver.y) <= 1
                    ) {
                        other.dead = false;
                        other.send(consts.channel_misc, "death", { dead: false });
                        other.set_hp(other.maxHp);
                        other.revive_time = 60000;
                        if (other.character) other.character.play_sound("revive", 1);
                        reviver.game?.speak(
                            `${other.user.username} was revived by ${reviver.user.username}`,
                            false,
                            "match",
                            "death/timer_up.ogg"
                        );
                        revived_someone = true;
                    }
                });
                if (revived_someone) return;
                player.map.interact(player);
                var grappler_obj = player.inventory.find_item("grappler");
                if (
                    grappler_obj instanceof Grappler_item &&
                    grappler_obj.target &&
                    grappler_obj.ready
                ) {
                    if (!grappler_obj.target.thrown)
                        grappler_obj.throw(data["angle"], data["pitch"]);
                    else if (grappler_obj.target.thrown) grappler_obj.pull();
                }
                var objects = player.map.get_objects_at(
                    {
                        x: player.x - 1,
                        y: player.y - 1,
                        width: 2,
                        height: 2,
                        z: player.z,
                        max_z: player.z,
                    },
                    true,
                    false
                );
                for (var i of objects) {
                    if (
                        i.on_interact(player, data["angle"], data["pitch"]) ==
                        true
                    )
                        return;
                }
                const wallbuy = player.map.get_wallbuy_at(
                    player.x,
                    player.y,
                    player.z
                );
                if (wallbuy && player.game && player.game.started) {
                    var weapon;
                    switch (wallbuy.weaponName) {
                        case "grenade":
                            weapon = new Grenade(
                                this.server,
                                player,
                                1,
                                "frag_grenade",
                                "A frag grenade",
                                30,
                                9,
                                random_number(3000, 5000)
                            );
                            if (player.points >= wallbuy.weaponCost) {
                                player.character?.play_sound("get_weapon");
                                player.inventory.add_item(weapon);
                                player.points =
                                    player.points - wallbuy.weaponCost;
                                player.speak(
                                    "You collected one frag grenade for " +
                                        wallbuy.weaponCost,
                                    true,
                                    "match",
                                    "wallbuy/grab.ogg"
                                );
                            } else {
                                player.character?.play_sound("no_money");
                            }
                            break;
                        case "radio":
                            weapon = new Item(
                                this.server,
                                player,
                                1,
                                "radio",
                                "a walky talky",
                                0,
                            );
                            if (player.points >= wallbuy.weaponCost) {
                                player.character?.play_sound("get_weapon");
                                player.inventory.add_item(weapon);
                                player.points =
                                    player.points - wallbuy.weaponCost;
                                player.speak(
                                    "You collected one radio for " +
                                        wallbuy.weaponCost,
                                    true,
                                    "match",
                                    "wallbuy/grab.ogg"
                                );
                                player.send(consts.channel_misc, "has_radio_self", {
                                    "enable": true
                                });
                                player.map.send(
                                    consts.channel_misc,
                                    "has_radio",
                                    {
                                        "channel": player.voice_channel,
                                        "enable": true
                                    }
                                );
                            } else {
                                player.character?.play_sound("no_money");
                            }
                            break;
                        default:
                            weapon = this.server.make_weapon({
                                owner: player,
                                name: wallbuy.weaponName,
                            });
                            player.speak(
                                "Wallbuy: " +
                                    wallbuy.ammoCost +
                                    " points to gain max ammo for " +
                                    wallbuy.weaponName +
                                    " and " +
                                    wallbuy.weaponCost +
                                    " points to buy it",
                                true,
                                "match",
                                "door/locked/"
                            );
                            if (weapon && player.points >= wallbuy.ammoCost) {
                                if (
                                    player.weapon_manager.find_by_name(
                                        weapon.name
                                    )
                                ) {
                                    var current_weapon =
                                        player.weapon_manager.find_by_name(
                                            weapon.name
                                        );
                                    if (current_weapon == null) {
                                        return;
                                    }
                                    if (
                                        (current_weapon.ammo <
                                            current_weapon.max_ammo &&
                                            current_weapon ==
                                                player.weapon_manager
                                                    .active_weapon) ||
                                        (current_weapon.reserved_ammo <
                                            current_weapon.max_reserved_ammo &&
                                            current_weapon ==
                                                player.weapon_manager
                                                    .active_weapon)
                                    ) {
                                        player.weapon_manager.modify(
                                            player.weapon_manager.weapons.indexOf(
                                                current_weapon
                                            ),
                                            {
                                                ammo: current_weapon.max_ammo,
                                                reserved_ammo:
                                                    current_weapon.max_reserved_ammo,
                                            }
                                        );
                                        player.speak(
                                            "You just restocked on ammo for your " +
                                                player.weapon_manager
                                                    .active_weapon.name +
                                                " for " +
                                                wallbuy.ammoCost +
                                                " points. ",
                                            true,
                                            "match"
                                        );
                                        player.points =
                                            player.points - wallbuy.ammoCost;
                                    }
                                }
                            }
                            if (player.points >= wallbuy.weaponCost) {
                                player.character?.play_sound("get_weapon");
                                if (
                                    player.weapon_manager.find_by_name(
                                        weapon.name
                                    )
                                ) {
                                    break;
                                }
                                if (player.weapon_manager.active_weapon)
                                    player.weapon_manager.replace(
                                        weapon,
                                        player.weapon_manager.weapons.indexOf(
                                            player.weapon_manager.active_weapon
                                        )
                                    );
                                player.speak(
                                    "You collected a " +
                                        wallbuy.weaponName +
                                        " for " +
                                        wallbuy.weaponCost +
                                        " points. ",
                                    true,
                                    "match"
                                );
                                player.play_sound(
                                    "wallbuy/grab.ogg",
                                    false,
                                    100
                                );
                                player.points =
                                    player.points - wallbuy.weaponCost;
                                player.weapon_manager.switch_weapon(
                                    player.weapon_manager.weapons.indexOf(
                                        weapon
                                    )
                                );
                                player.send(
                                    consts.channel_weapons,
                                    "switch_weapon",
                                    {
                                        slot: player.weapon_manager.weapons.indexOf(
                                            weapon
                                        ),
                                    }
                                );
                            } else {
                                player.character?.play_sound("no_money");
                            }
                            break;
                    }
                }
                const door = player.map.get_door_at(
                    player.x,
                    player.y,
                    player.z
                );
                if (door != null) {
                    if (door.open) {
                        door.switch_state(false, true);
                    } else if (player.game && player.game.started) {
                        if (player.points >= door.minpoints) {
                            player.points = player.points - door.minpoints;
                            player.speak(
                                "You lost " +
                                    door.minpoints +
                                    " points in opening this door"
                            );
                            door.switch_state(true, false);
                        } else {
                            player.speak(
                                "This door is locked. You need " +
                                    door.minpoints +
                                    " points to open this door. "
                            );
                        }
                    } else {
                        door.switch_state(true, false);
                    }
                }
            }
        },
        player_radar(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            var in_radius = player.players_in_radius(data["radius"]);
            var message = "";
            if (in_radius.length > 0) {
                for (let i in in_radius) {
                    let i_num = parseInt(i);
                    if (i_num < in_radius.length - 2) {
                        message += in_radius[i] + ", ";
                    } else if (i_num == in_radius.length - 2) {
                        message += in_radius[i] + " and ";
                    } else if (i_num == in_radius.length - 1) {
                        message = message + in_radius[i] + " ";
                    }
                }
                if (in_radius.length == 1) {
                    message += "is in a five tile distance of you. ";
                } else if (in_radius.length > 1) {
                    message += "are in a five tile radius of you. ";
                }
            } else if (in_radius.length == 0) {
                message = "There is no one in a five tile radius of you. ";
            }
            player.speak(message, true, "players");
        },
        draw_weapon(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.weapon_manager.switch_weapon(data.num);
        },
        weapon_fire(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player || !player.game) return;
            const angle = data.angle, pitch = data.pitch;
            if (!Number.isFinite(angle) || !Number.isFinite(pitch)) return;
            player.weapon_manager.fire(angle, pitch);
        },
        weapon_reload(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            player.weapon_manager.reload();
        },
        async submit_ticket(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            var message = data["message"].trim();
            const category = data["category"];

            const ticket_return = await this.server.database.tickets.create({
                user_id: player.user.id,
                author: player.user.username,
                status: "open",
                category: category,
                message_list: [message],
            });
            let cat = channel_id.tickets;
            if (ticket_return.category == "building") cat = channel_id.building_tickets;
            this.server.discord.send_message(
                `Author: ${ticket_return.author}\r\nCategory: ${ticket_return.category}\r\n\r\n> ${ticket_return.message_list[0]}\r\n\r\nResponses: ${ticket_return.message_list.length-1}`,
                cat,
                ticket_return.ticket_id.toString()
            );

            player.user.log({
                eventType: "ticket_submit",
                eventData: {
                    id: ticket_return.ticket_id,
                },
            });
            if (ticket_return.category == "building")
                this.server.speakbuilders(
                    player.user.username +
                        " just submitted a ticket, please make sure you check it. ",
                    true,
                    "staff",
                    "ui/notify2.ogg"
                );
            else
                this.server.speakmods(
                    player.user.username +
                        " just submitted a ticket, please make sure you check it. ",
                    true,
                    "staff",
                    "ui/notify2.ogg"
                );

            player.speak("submitted ticket, please check back soon. ");
        },
        async edit_ticket(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            const ticket = data["ticket"];
            if (
                (player.user.username.toLowerCase() ==
                    ticket["author"].toLowerCase() &&
                    ticket["status"] != "closed") ||
                player.moderator
            ) {
                player.speak("Edited ticket");
                player.user.log({
                    eventType: "ticket_edit",
                    eventData: {
                        id: ticket["id"],
                    },
                });
                var ticket_db =
                    await this.server.database.tickets.get_ticket_by_id(
                        ticket["id"]
                    );
                ticket_db.author = ticket.author;
                ticket_db.status = ticket.status;
                ticket_db.category = ticket.category;
                ticket_db.message_list = ticket.message_list;
                ticket_db.save();
                let discord_message_id = ticket_db.discord_message_id;
                this.server.discord.edit_ticket(discord_message_id, ticket_db);
                this.server.speakmods(
                    player.user.username +
                        " just edit the ticket with the id " +
                        ticket["id"] +
                        " originally created by " +
                        ticket["author"],
                    true,
                    "staff",
                    "ui/notify2.ogg"
                );
                this.server.offline_speak(
                    ticket["author"],
                    "Your ticket with ticket id: " +
                        ticket["id"] +
                        " has been editted",
                    false,
                    "staff alerts",
                    "ui/notify2.ogg"
                );
            } else {
                player.speak("You can't do that");
            }
        },
        async send_ticket_message(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            const id = data["id"];
            var message = data["message"];
            var ticket = await this.server.database.tickets.get_ticket_by_id(
                to_num(id)
            );

            if (data["status"] == "closed") {
                player.speak("This ticket is closed");
            } else {
                if (player.moderator) message = "moderator: " + message;
                else if (
                    player.builder &&
                    ticket.category == "building" &&
                    !player.moderator
                )
                    message = `builder: ${message}`;
                ticket.message_list = ticket.message_list.concat([message]);
                if (
                    (player.moderator && !message.endsWith("!close")) ||
                    (player.builder &&
                        ticket.category == "building" &&
                        !message.endsWith("!close"))
                ) {
                    ticket.status = "seen";
                    player.user.log({
                        eventType: "ticket_reply",
                        eventData: {
                            id: ticket.ticket_id,
                        },
                    });
                    this.server.offline_speak(
                        ticket.author,
                        "Your ticket with ticket id: " +
                            id +
                            " has been seen by a moderator",
                        false,
                        "staff alerts",
                        "ui/notify2.ogg"
                    );
                    if (ticket.category == "building")
                        this.server.speakbuilders(
                            player.user.username +
                                " responded to the ticket with id " +
                                id,
                            true,
                            "staff",
                            "ui/notify2.ogg"
                        );
                    else
                        this.server.speakmods(
                            player.user.username +
                                " responded to the ticket with id " +
                                id,
                            true,
                            "staff",
                            "ui/notify2.ogg"
                        );
                } else if (
                    (player.moderator && message.endsWith("!close")) ||
                    (player.builder &&
                        ticket.category == "building" &&
                        message.endsWith("!close"))
                ) {
                    ticket.status = "closed";
                    player.user.log({
                        eventType: "ticket_close",
                        eventData: {
                            id: ticket.ticket_id,
                        },
                    });
                    this.server.offline_speak(
                        ticket.author,
                        "Your ticket with ticket id: " +
                            id +
                            " has been closed by a moderator",
                        false,
                        "staff alerts",
                        "ui/notify2.ogg"
                    );
                    if (ticket.category == "building")
                        this.server.speakbuilders(
                            player.user.username +
                                " closed the ticket with id " +
                                id,
                            true,
                            "staff",
                            "ui/notify2.ogg"
                        );
                    else
                        this.server.speakmods(
                            player.user.username +
                                " closed the ticket with id " +
                                id,
                            true,
                            "staff",
                            "ui/notify2.ogg"
                        );
                }
                ticket.save();
                player.speak("sent message");
            }
            ticket.save();
        },
        get_game_coords(peer, data) {
            var player = this.server.get_by_peer(peer);
            if (!player) return;
            if (player.game) {
                if (player.game.players.size >= data["player"]) {
                    var target = Array.from(player.game.players)[
                        data["player"] - 1
                    ];
                    var status = "";
                    if (target.hp <= 20 && !target.dead) {
                        status = ", (low health)";
                    } else if (target.dead) {
                        status = ", (dead)";
                    }
                    player.speak(
                        target.user.username +
                            ": " +
                            Math.trunc(target.x) +
                            ", " +
                            Math.trunc(target.y) +
                            ", " +
                            Math.trunc(target.z) +
                            status,
                        true
                    );
                }
            }
        },
    };
    async handel_command(player: Player, commandString: string) {
        let commandParts = commandString.slice(1).split(" ");
        switch (commandParts[0]) {
            case "me":
                var message = commandParts.slice(1).join(" ");
                if (message != "") {
                    player.emote(message);
                } else {
                    player.speak("You need to send contents in your message. ");
                }
                break;
            case "tell":
            case "@":
                var message = commandParts.slice(2).join(" ");
                for (let i of commandParts[1].split(",")) {
                    if (this.server.get_by_username(i)) {
                        var target = this.server.get_by_username(i);
                        if (target && message != "") {
                            player.send_pm(target, message);
                        }
                    } else if (
                        await this.server.database.users.username_exists(i)
                    ) {
                        var message = commandParts.slice(2).join(" ");
                        if (message != "") {
                            this.server.offline_speak(
                                i,
                                "offline tell from " +
                                    player.user.username +
                                    ": " +
                                    message,
                                true,
                                "tell",
                                "ui/pm.ogg"
                            );
                            player.user.log({
                                eventType: "tell",
                                eventData: {
                                    sender: player.user.username,
                                    receiver: commandParts[1],
                                    message: message,
                                },
                            });
                        }
                        player.speak(
                            "Offline tell to " + i + ": " + message,
                            true,
                            "tell",
                            "ui/pm.ogg"
                        );
                    }
                }
                break;
            case "r":
            case "reply":
                var message = commandParts.slice(1).join(" ");
                if (message != "") {
                    if (player.reply_list.length == 0) {
                        player.speak(
                            "You have no tell's to reply to! ",
                            true,
                            "main"
                        );
                    } else if (player.reply_list.length == 1) {
                        var target = this.server.get_by_username(
                            player.reply_list[0][0]
                        );
                        if (target) {
                            player.send_pm(target, message);
                        } else if (
                            await this.server.database.users.username_exists(
                                player.reply_list[0][0]
                            )
                        ) {
                            this.server.offline_speak(
                                player.reply_list[0][0],
                                "offline tell from " +
                                    player.user.username +
                                    ": " +
                                    message,
                                true,
                                "tell",
                                "ui/pm.ogg"
                            );
                            player.speak(
                                "Offline tell to " +
                                    player.reply_list[0][0] +
                                    ": " +
                                    message,
                                true,
                                "tell",
                                "ui/pm.ogg"
                            );
                        }
                    } else {
                        var reply_menu = new menu(
                            this.server,
                            "Reply menu",
                            "send_reply"
                        );
                        for (let i of player.reply_list) {
                            reply_menu.add_option(i[0] + ": " + i[1], [
                                i[0],
                                message,
                            ]);
                        }
                        reply_menu.send(player.peer);
                    }
                }
                break;
            case "setsm":
                if (player.contributor) {
                    var message = commandParts.slice(1).join(" ");
                    this.server.speak(
                        `The server message has been changed by a contributor. The new message is: ${message}`,
                        false,
                        "notifications",
                        "ui/notify1.ogg"
                    );
                    player.user.log({
                        eventType: "server_message",
                        eventData: message,
                    });

                    fs.writeFile("./sm.txt", message);
                }
                break;
            case "set":
                if (player.contributor) {
                    const priv = commandParts[1].toLowerCase().trim();
                    const targetname = commandParts[2].trim();
                    const value =
                        commandParts[3].toLowerCase().trim() == "yes"
                            ? true
                            : false;
                    var target = this.server.get_by_username(targetname);
                    if (target && value) {
                        switch (priv) {
                            case "moderator":
                                if (target.moderator) {
                                    player.speak(
                                        "You can't make a moderator a moderator for a second time, you know? "
                                    );
                                } else {
                                    target.user.moderator = true;
                                    target.speak(
                                        `You have been promoted to a ${priv} by ${player.name}.`,
                                        true,
                                        "tell"
                                    );
                                    player.speak("Done. ");
                                    player.user.log({
                                        eventType: "promote",
                                        eventData: {
                                            rank: "moderator",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                    target.user.log({
                                        eventType: "promote",
                                        eventData: {
                                            rank: "moderator",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                }
                                break;
                            case "builder":
                                if (target.builder) {
                                    player.speak(
                                        "You can't make a builder a builder for a second time, you know? "
                                    );
                                } else {
                                    target.user.builder = true;
                                    target.speak(
                                        `You have been promoted to a ${priv} by ${player.name}.`,
                                        true,
                                        "tell"
                                    );
                                    player.speak("done. ");
                                    player.user.log({
                                        eventType: "promote",
                                        eventData: {
                                            rank: "builder",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                    target.user.log({
                                        eventType: "promote",
                                        eventData: {
                                            rank: "builder",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                }
                                break;
                            default:
                                return;
                        }
                        target.save();
                    } else if (target && !value) {
                        switch (priv) {
                            case "moderator":
                                if (!target.moderator) {
                                    player.speak(
                                        "I apreciate the effort, but you can't demote someone from a rank when they don't have that rank anyway! "
                                    );
                                } else {
                                    target.user.moderator = false;
                                    target.speak(
                                        `You have been demoted from your ${priv} rank by a contributor.`,
                                        true,
                                        "tell"
                                    );
                                    player.speak("done. ");
                                    player.user.log({
                                        eventType: "demote",
                                        eventData: {
                                            rank: "player",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                    target.user.log({
                                        eventType: "demote",
                                        eventData: {
                                            rank: "player",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                }
                                break;
                            case "builder":
                                if (!target.builder) {
                                    player.speak(
                                        "I apreciate the effort, but you can't demote someone from a rank when they don't have that rank anyway! "
                                    );
                                } else {
                                    target.user.builder = false;
                                    target.speak(
                                        `You have been demoted from your ${priv} rank by a contributor.`,
                                        true,
                                        "tell"
                                    );
                                    player.speak("done. ");
                                    player.user.log({
                                        eventType: "demote",
                                        eventData: {
                                            rank: "player",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                    target.user.log({
                                        eventType: "demote",
                                        eventData: {
                                            rank: "player",
                                            promoter: player.user.username,
                                            target: target.user.username,
                                        },
                                    });
                                }
                                break;
                            default:
                                return;
                        }
                        target.save();
                    }
                }
                break;
            case "rules":
                player.speak(
                    "Redirecting to https://finalhour.lowerelements.club/agreement",
                    true,
                    "main"
                );
                player.send(consts.channel_misc, "open_rules", {});
                break;
            case "help":
                const help = (
                    await fs.readFile("./help.txt", { encoding: "utf-8" })
                )
                    .trim()
                    .split(/\r?\n/);
                var help_menu = new menu(this.server, "help menu", "copy_menu");
                help_menu.add_option("help_menu", "help_menu");
                for (let i of help) {
                    help_menu.add_option(i, i);
                }
                help_menu.send(player.peer);
                break;
            case "modhelp":
                if (player.moderator) {
                    const help = (
                        await fs.readFile("./modhelp.txt", {
                            encoding: "utf-8",
                        })
                    )
                        .trim()
                        .split(/\r?\n/);
                    var help_menu = new menu(
                        this.server,
                        "mod help menu",
                        "copy_menu"
                    );
                    help_menu.add_option("help_menu", "help_menu");
                    for (let i of help) {
                        help_menu.add_option(i, i);
                    }
                    help_menu.send(player.peer);
                }
                break;
            case "builderhelp":
                if (player.builder) {
                    const help = (
                        await fs.readFile("./builderhelp.txt", {
                            encoding: "utf-8",
                        })
                    )
                        .trim()
                        .split(/\r?\n/);
                    var help_menu = new menu(
                        this.server,
                        "builder help menu",
                        "copy_menu"
                    );
                    help_menu.add_option("help_menu", "help_menu");
                    for (let i of help) {
                        help_menu.add_option(i, i);
                    }
                    help_menu.send(player.peer);
                }
                break;
            case "getmapdata":
                if (player.builder) {
                    player.send(consts.channel_map, "copy", {
                        data: player.map.real_data,
                        message: "Map data exported to your clipboard",
                    });
                }
                break;
            case "setmapdata":
                if (player.builder) {
                    const map_data = commandParts.slice(1).join(" ");
                    try {
                        await player.map.update(map_data);
                        player.speak("Done");
                    } catch (err) {
                        player.speak(`Error while updating map. ${err}`);
                    }
                }
                break;
            case "move":
                if (player.builder) {
                    var target = this.server.get_by_username(commandParts[1]);
                    if (!target) break;
                    var x = to_num(commandParts[2]);
                    var y = to_num(commandParts[3]);
                    var z = to_num(commandParts[4]);
                    var _map =
                        this.server.maps[commandParts[5] ?? target.map.mapName];
                    target.change_map(_map, x, y, z);
                }
                break;
            case "mkmap":
                if (player.builder && commandParts.length > 7) {
                    const name = commandParts[1];
                    const minx = to_num(commandParts[2]);
                    const maxx = to_num(commandParts[3]);
                    const miny = to_num(commandParts[4]);
                    const maxy = to_num(commandParts[5]);
                    const minz = to_num(commandParts[6]);
                    const maxz = to_num(commandParts[7]);
                    const new_map = await this.server.create_map({
                        name,
                        minx,
                        maxx,
                        miny,
                        maxy,
                        minz,
                        maxz,
                    });
                    if (new_map) {
                        player.change_map(
                            new_map,
                            minx + 1,
                            miny + 1,
                            minz + 1
                        );
                    }
                }
                break;
            case "chmap":
                if (player.builder) {
                    if (commandParts.length >= 2) {
                        const _map = this.server.maps[commandParts[1]];
                        if (_map) {
                            player.change_map(_map);
                        }
                    } else {
                        var m = new menu(
                            this.server,
                            "please choose the map to which you want to be teleported.",
                            "change_map"
                        );
                        for (let i of Object.keys(this.server.maps)) {
                            m.add_option(i, i);
                        }
                        m.send(player.peer);
                    }
                }
                break;
            case "kick":
                if (!player.moderator) break;
                var target = this.server.get_by_username(commandParts[1]);
                var reason = commandParts.slice(3).join(" ");
                if (!target) break;
                if (player.moderator) {
                    if (commandParts[2] == "public") {
                        this.server.speak(
                            `${target.user.username} was just kicked by a moderator for ${reason}`,
                            true,
                            "staff alerts",
                            "ui/notify1.ogg"
                        );
                        player.user.log({
                            eventType: "kick",
                            eventData: {
                                actioner: player.user.username,
                                actioned: target.user.username,
                                reason: reason,
                            },
                        });
                        target.user.log({
                            eventType: "kick",
                            eventData: {
                                actioner: player.user.username,
                                actioned: target.user.username,
                                reason: reason,
                            },
                        });
                    } else if (commandParts[2] == "private") {
                        this.server.speak(
                            `${target.user.username} was just kicked from the server by a moderator. `,
                            true,
                            "staff alerts",
                            "ui/notify1.ogg"
                        );
                    } else {
                        break;
                    }
                    this.server.speakmods(
                        `${target.user.username} was just kicked by ${player.user.username} for ${reason}`,
                        false,
                        "staff"
                    );
                    player.speak("done", false);
                }
                target.send(consts.channel_misc, "quit", {
                    message: `You were kicked for ${reason}`,
                });
                await target.save();
                break;
            case "asmod":
                if (player.moderator) {
                    var message = commandParts.slice(1).join(" ");
                    if (message.trim())
                        this.server.speak(
                            `Moderator: ${message}. (This message is on behalf of the Final Hour Staff team. If you experience any misconduct through one of these messages, please submit a report ticket using '/tickets'.)`,
                            true,
                            "staff alerts",
                            "ui/notify1.ogg"
                        );
                    this.server.speakmods(
                        `${player.user.username} just sent the asmod message: ${message}.`,
                        true,
                        "staff"
                    );
                    player.user.log({
                        eventType: "asmod",
                        eventData: message,
                    });
                }
                break;
            case "tellmod":
                var target = this.server.get_by_username(commandParts[1]);
                if (player.moderator && target) {
                    var message = commandParts.slice(2).join(" ");
                    player.send_pmmod(target, message);
                }
                break;
            case "conchat":
            case "c":
                if (player.contributor) {
                    var message = commandParts.slice(1).join(" ");
                    if (message.trim()) {
                        this.server.speakcontributors(
                            `Contributor chat ${player.user.username}: ${message} `,
                            false,
                            "staff",
                            "ui/notify2.ogg"
                        );
                        player.user.log_chat("conchat", message);
                        this.server.discord.send_message(
                            message,
                            channel_id.development,
                            player.user.username
                        );
                    }
                }
                break;
            case "modchat":
            case "m":
                if (player.moderator) {
                    var message = commandParts.slice(1).join(" ");
                    if (message.trim()) {
                        this.server.speakmods(
                            `Mod chat ${player.user.username}: ${message} `,
                            false,
                            "staff",
                            "ui/notify2.ogg"
                        );
                        player.user.log_chat("modchat", message);
                    }
                }
                break;
            case "buildchat":
            case "b":
                if (player.builder) {
                    var message = commandParts.slice(1).join(" ");
                    if (message.trim()) {
                        this.server.speakbuilders(
                            `builder chat ${player.user.username}: ${message} `,
                            false,
                            "staff",
                            "ui/notify2.ogg"
                        );
                        this.server.discord.send_message(message, channel_id.building, player.user.username);
                        player.user.log_chat("buildchat", message);
                    }
                }
                break;
            case "staff":
                var message = "Staff: \r\nBuilders: \r\n";
                if (player.builder) {
                    const builders = await this.server.database.users.findAll({
                        where: {
                            builder: true,
                        },
                    });
                    for (let i of builders) message += `${i.username}, `;
                    message = message + "\r\nModerators: \r\n";
                    const moderators = await this.server.database.users.findAll(
                        {
                            where: { moderator: true },
                        }
                    );
                    for (let i of moderators) message += `${i.username}, `;
                    message = message + "\r\nContributors: \r\n";
                    for (let i of this.server.contributors) message += `${i}, `;
                    player.speak(message, false, "main");
                }
                break;
            case "matches":
                if (player.contributor) {
                    player.speak(
                        `${this.server.games.length} matches are currently created`
                    );
                    for (let i of this.server.games) {
                        i.speak(
                            "A contributor would like to restart the server, you may want to destroy your match so that any highscores get saved to the leaderboard. Sorry for the inconvenience. ",
                            true,
                            "match",
                            "ui/notify1.ogg"
                        );
                    }
                }
                break;
            case "donate":
            case "d":
                var target = this.server.get_by_username(commandParts[1]);
                if (!target) break;
                var amount = to_num(commandParts[2]);
                var itemname = commandParts.slice(3).join("_");
                var item = player.inventory.find_item(itemname);
                if (item == null) {
                    player.speak("You don't have this item");
                    break;
                } else if (item.amount < amount) {
                    player.speak("You don't have enough of this item");
                    break;
                } else if (amount <= 0) {
                    player.speak("You can't give fewer than 1 item to somebody");
                    break;
                } else if (get_distance(
                    {
                        x: player.x,
                        y: player.y,
                        z: player.z
                    },
                    {
                        x: target.x,
                        y: target.y,
                        z: target.z
                    }
                ) > 5) {
                    player.speak("You are too far away");
                    break;
                }
                switch (itemname) {
                    case "frag_grenade":
                        target.inventory.add_item(
                            new Grenade(
                                this.server,
                                target,
                                amount,
                                "frag_grenade",
                                "a frag grenade",
                                30,
                                9,
                                random_number(3000, 5000)
                            )
                        );
                        player.inventory.take_item("frag_grenade", amount);
                        break;
                    case "radio":
                        target.inventory.add_item(new Item(
                            this.server,
                            target,
                            amount,
                            "radio",
                            "a radio",
                            0
                        ));
                        player.inventory.take_item(
                            "radio", amount
                        );
                        target.send(
                            consts.channel_misc,
                            "has_radio_self",
                            {
                                "enable": true
                            }
                        );
                        target.map.send(
                            consts.channel_misc,
                            "has_radio",
                            {
                                "channel": target.voice_channel,
                                "enable": true
                            }
                        );
                        if (!player.inventory.find_item("radio")) {
                            player.send(
                                consts.channel_misc,
                                "has_radio_self",
                                {
                                    "enable": false
                                }
                            );
                            player.map.send(
                                consts.channel_misc,
                                "has_radio",
                                {
                                    "channel": player.voice_channel,
                                    "enable": false
                                }
                            );    
                        }
                        break;
                    default:
                        target.inventory.add_item(
                            new Item(
                                this.server,
                                target,
                                amount,
                                itemname
                            )
                        );
                        player.inventory.take_item(
                            itemname,
                            amount
                        );
                        break;
                }
                player.speak(
                    `You just handed ${amount} ${itemname}s to ${target?.name}`,
                    true,
                    "players",
                );
                player.play_sound(
                    "items/give.ogg",
                );
                target?.speak(
                    `${player.name} just handed ${amount} ${itemname}s to you.`,
                    true,
                    "players",
                );
                target.play_sound(
                    "items/recieve.ogg"
                );

                break;
            case "give":
                if (player.moderator) {
                    var target = this.server.get_by_username(commandParts[1]);
                    if (!target) break;
                    var amount = to_num(commandParts[2]);
                    var itemname = commandParts.slice(3).join("_");
                    if (amount > 0) {
                        switch (itemname) {
                            case "grenade":
                                target.inventory.add_item(
                                    new Grenade(
                                        this.server,
                                        target,
                                        amount,
                                        "frag_grenade",
                                        "a frag grenade",
                                        30,
                                        9,
                                        random_number(3000, 5000)
                                    )
                                );
                                break;
                            case "radio":
                                target.inventory.add_item(new Item(
                                    this.server,
                                    target,
                                    amount,
                                    "radio",
                                    "a radio",
                                    0
                                ));
                                target.send(
                                    consts.channel_misc,
                                    "has_radio_self",
                                    {
                                        "enable": true
                                    }
                                );
                                target.map.send(
                                    consts.channel_misc,
                                    "has_radio",
                                    {
                                        "channel": target.voice_channel,
                                        "enable": true
                                    }
                                );
                                break;
                            default:
                                target.inventory.add_item(
                                    new Item(
                                        this.server,
                                        target,
                                        amount,
                                        itemname
                                    )
                                );
                                break;
                        }
                    } else if (amount < 0) {
                        target.inventory.take_item(itemname, amount * -1);
                    }
                    this.server.speakmods(
                        `${
                            player.user.username
                        } just gave ${amount.toString()} ${itemname} to ${
                            target.user.username
                        }`,
                        false,
                        "staff",
                        "ui/notify2.ogg"
                    );
                    target.speak(
                        `You were just given ${amount.toString()} ${itemname} by a moderator. `,
                        true,
                        "main"
                    );
                    target.user.log({
                        eventType: "give",
                        eventData: {
                            amount: amount,
                            provider: player.user.username,
                            receiver: target.user.username,
                            item: itemname,
                        },
                    });
                    player.user.log({
                        eventType: "give",
                        eventData: {
                            amount: amount,
                            provider: player.user.username,
                            receiver: target.user.username,
                            item: itemname,
                        },
                    });
                }
                break;
            case "modtell":
                var message = commandParts.slice(1).join(" ");
                this.server.speakmods(
                    `${player.user.username} just sent the modtell: ${message}`,
                    false,
                    "staff",
                    "ui/notify2.ogg"
                );
                player.speak(
                    `You just sent the modtell: ${message}`,
                    true,
                    "main"
                );
                player.user.log({
                    eventType: "modtell",
                    eventData: message,
                });
                break;
            case "sethp":
                if (player.moderator) {
                    var target = this.server.get_by_username(commandParts[1]);
                    if (!target) break;
                    var amount = to_num(commandParts[2]);
                    target.set_hp(amount);
                    player.speak("done");
                    target.speak(
                        `A moderator just set your health to ${amount.toString()}.`,
                        true,
                        "main"
                    );
                    this.server.speakmods(
                        `${player.user.username} just set ${
                            target.user.username
                        }'s health to ${amount.toString()}. `,
                        false,
                        "staff",
                        "ui/notify2.ogg"
                    );
                    player.user.log({
                        eventType: "set_hp",
                        eventData: {
                            hp: amount,
                            actioner: player.user.username,
                            actioned: target.user.username,
                        },
                    });
                    target.user.log({
                        eventType: "set_hp",
                        eventData: {
                            hp: amount,
                            actioner: player.user.username,
                            actioned: target.user.username,
                        },
                    });
                }
                break;
            case "find_path":
                var x = to_num(commandParts[1]);
                var y = to_num(commandParts[2]);
                var z = to_num(commandParts[3]);
                player.speak(
                    `${await player.map.find_path(
                        player.x,
                        player.y,
                        player.z,
                        x,
                        y,
                        z
                    )}`
                );
                break;
            case "mainmenu":
                player.main_menu();
                break;
            case "invisible":
                if (player.contributor) {
                    player.toggle_invis();
                }
                break;
            case "tickets":
                var tickets: any[] = [];
                if (commandParts[1] == "closed") {
                    var sql_tickets =
                        await this.server.database.tickets.get_closed_tickets();
                    for (var ticket of sql_tickets) {
                        tickets.push({
                            id: ticket.ticket_id,
                            author: ticket.author,
                            category: ticket.category,
                            status: ticket.status,
                            message_list: ticket.message_list,
                        });
                    }
                    var mod = false;
                    if (player.moderator) {
                        mod = true;
                    }
                    player.send(consts.channel_menus, "view_closed_tickets", {
                        tickets: tickets,
                        moderator: mod,
                    });
                } else if (commandParts[1] == "building" && player.builder) {
                    const sql_tickets =
                        await this.server.database.tickets.get_building_tickets();
                    for (var ticket of sql_tickets) {
                        tickets.push({
                            id: ticket.ticket_id,
                            author: ticket.author,
                            category: ticket.category,
                            status: ticket.status,
                            message_list: ticket.message_list,
                        });
                    }

                    var mod = false;
                    if (player.moderator) {
                        mod = true;
                    }
                    player.send(consts.channel_menus, "tickets_menu", {
                        tickets: tickets,
                        moderator: mod,
                    });
                } else if (commandParts[1] == "staff" && player.moderator) {
                    const sql_tickets =
                        await this.server.database.tickets.get_open_tickets();
                    for (var ticket of sql_tickets) {
                        tickets.push({
                            id: ticket.ticket_id,
                            author: ticket.author,
                            category: ticket.category,
                            status: ticket.status,
                            message_list: ticket.message_list,
                        });
                    }

                    var mod = false;
                    if (player.moderator) {
                        mod = true;
                    }
                    player.send(consts.channel_menus, "view_closed_tickets", {
                        tickets: tickets,
                        moderator: mod,
                    });
                } else {
                    const sql_tickets =
                        await this.server.database.tickets.get_all_tickets_by_userid(
                            player.user.id
                        );
                    for (var ticket of sql_tickets) {
                        tickets.push({
                            id: ticket.ticket_id,
                            author: ticket.author,
                            category: ticket.category,
                            status: ticket.status,
                            message_list: ticket.message_list,
                        });
                    }
                    var mod = false;
                    if (player.moderator) {
                        mod = true;
                    }
                    player.send(consts.channel_menus, "tickets_menu", {
                        tickets: tickets,
                        moderator: mod,
                    });
                }
                break;
            case "block":
                var target_name = commandParts[1];
                if (player.user.blocked_players.includes(target_name)) {
                    player.speak(`You've already blocked ${target_name}`);
                    break;
                }
                var target = this.server.get_by_username(target_name);

                if (
                    target && 
                    target instanceof Player && 
                    !target.moderator
                ) {
                    target.user.block_list = target.user.block_list.concat([player.user.username]);
                    player.user.blocked_players = player.user.blocked_players.concat([target_name])
                    await target.user.save();
                    await player.user.save();
                    player.speak(`You just blocked ${target.name}`);
                } else if (await this.server.database.users.username_exists(target_name)) {
                    var target_user = await this.server.database.users.get_by_username(target_name);
                    if (
                        target_user instanceof User &&
                        !target_user.moderator &&
                        !this.server.contributors.includes(target_name)
                    ) {
                        target_user.block_list = target_user.block_list.concat([player.user.username]);
                        player.user.blocked_players = player.user.blocked_players.concat([target_name]);
                        target_user.save()
                        player.user.save();
                        player.speak(`You have blocked ${target_user.username}.`);
                    }
                } else {
                    player.speak("Error, invalid player name");
                } 
                if (target?.moderator || this.server.contributors.includes(target_name)) {
                    player.speak("You can't mute moderators");
                }
                
                break;
            case "unblock":
                var target = this.server.get_by_username(commandParts[1]);
                if (target && target instanceof Player) {
                    target.user.block_list = 
                    target.user.block_list.slice(0, target.user.block_list.indexOf(player.user.username))
                    .concat(target.user.block_list.slice(target.user.block_list.indexOf(player.user.username)+1));
                    player.user.blocked_players = 
                    player.user.blocked_players.slice(0, player.user.blocked_players.indexOf(target.user.username))
                    .concat(player.user.blocked_players.slice(player.user.blocked_players.indexOf(target.user.username)+1));
                    await target.user.save();
                    await player.user.save();
                    player.speak(`${target.user.username} unblocked. `);
                } else if (!target && await this.server.database.users.username_exists(commandParts[1])) {
                    var target_user = await this.server.database.users.get_by_username(commandParts[1]);
                    target_user.block_list = 
                    target_user.block_list.slice(0, target_user.block_list.indexOf(player.user.username))
                    .concat(target_user.block_list.slice(target_user.block_list.indexOf(player.user.username)+1));
                    player.user.blocked_players = 
                    player.user.blocked_players.slice(0, player.user.blocked_players.indexOf(target_user.username))
                    .concat(player.user.blocked_players.slice(player.user.blocked_players.indexOf(target_user.username)+1));
                    await target_user.save();
                    await player.user.save();
                    player.speak(`${target_user.username} unblocked. `);

                } else {
                    player.speak("That player either doesn't exist or isn't on your block list");
                }

                break;
            case "blockslist":
                if (player.user.blocked_players.length < 1) {
                    player.speak("You have blocked no body", true, "main");
                } else {
                    var message = "You have blocked: \r\n";
                    for (let block of player.user.blocked_players) {
                        if (player.user.blocked_players.indexOf(block) == player.user.blocked_players.length - 1) message = `${message}${block}.\r\n`
                        else if (player.user.blocked_players.indexOf(block) == player.user.blocked_players.length -2) message = `${message}${block}, \r\nand\r\n`;
                        else message = `${message}${block},\r\n`;
                    }
                    player.speak(message, true, "main");
                }
                break;
            
                case "permban":
                    if (!player.moderator) break;
                    var target = this.server.get_by_username(commandParts[1]);
                    if (!target) {
                        player.speak("This player does not exist");
                        break;
                    }
                    var IP: boolean;
                    if (commandParts[2].toUpperCase() == "IP") IP = true;
                    else if (commandParts[2].toLowerCase() == "account_only") IP = false;
                    else {
                        player.speak("Invalid option for ban type, options are IP or account_only");
                        break;
                    }
                    var public_reason: boolean;
                    if (commandParts[3].toLowerCase() == "public") public_reason = true;
                    else public_reason = false;
                    var reason = commandParts.slice(4).join(" ");
                    target.user.permban = true;
                    target.user.banReason = reason;
                    if (IP) {
                        target.user.IPBans = target.user.IPBans.concat([target.peer.address().address]);
                        var ban = await this.server.database.IPBans.create({
                            permban: true,
                            tempban: false,
                            IP: target.peer.address().address,
                            reason: reason,
                            expiryDate: 0
                        });
                        await ban.save();

                    }
                    var message: string;
                    if (public_reason) message = `${target.user.username} has been banned. Reason: ${reason}`;
                    else message = `${target.user.username} has been banned.`;
                    this.server.speak(message, false, "notifications", "ui/notify1.ogg");
                    this.server.speakmods(`${player.user.username} has banned ${target.user.username} for ${reason}`, true, "staff", "ui/notify2.ogg");
                    target.send(consts.channel_misc, "quit", {
                        message: `You have been banned. Reason: ${reason}`
                    });
                    await target.save()
                    break;
                case "unban":
                    if (!player.moderator) break;
                    if (await this.server.database.users.username_exists(commandParts[1])) {
                        let user = await this.server.database.users.findOne({
                            where: { normalized_username: commandParts[1].toLowerCase() },
                        });
                        if (!user) {
                            player.speak("Invalid username");
                            break;
                        }
                        if (user.IPBans.length == 0 && !user.permban) {
                            player.speak("This player is not banned")
                            break;
                        }
                        user.permban = false;
                        for (let ban of user.IPBans) {
                            var IP_ban = await this.server.database.IPBans.findOne({
                                where: { IP: ban }
                            })
                            if (IP_ban instanceof IPBan) await IP_ban.destroy();
                        }
                        await user.save();
                        this.server.speak(`${user.username} was just unbanned.`, false, "notifications", "ui/notify1.ogg");
                        this.server.speakmods(`${player.user.username} just unbanned ${user.username}.`, true, "staff", "ui/notify2.ogg");
                    }
                    break;
                case "banlist":
                    if (!player.moderator) break;
                    const types = commandParts.slice(1);
                    message = "Bans:\r\n";
                    for (let type of types) {
                        if (type.toLowerCase() == "users") {
                            var users = await this.server.database.users.findAll({
                                where: { permban: true }
                            });
                            for (let user of users) message = `${message}${user.username}, `;
                        } else if (type.toLowerCase() == "ips") {
                            const ips = await this.server.database.IPBans.findAll();
                            for (let IP of ips) message = `${message}${IP.IP}, `;
                        }
                    }
                    break;
                case "tempban":
                    if (!player.moderator) break;
                    var target = this.server.get_by_username(commandParts[1])
                    var month = 0;
                    var day = 1;
                    var year = 2026
                    var hour = 0;
                    var minute = 0;
                    var second = 0;
                    const date_string = commandParts[2].split(":");
                    if (date_string[0]) month = to_num(date_string[0])-1;
                    if (date_string[1]) day = to_num(date_string[1]);
                    if (date_string[2]) year = to_num(date_string[2]);
                    if (date_string[3]) hour = to_num(date_string[3]);
                    if (date_string[4]) minute = to_num(date_string[4]);
                    if (date_string[5]) second = to_num(date_string[5]);
                    var ban = await this.server.database.IPBans.create({
                        IP: target?.peer.address().address,
                        permban: false,
                        tempban: true,
                        expiryDate: Date.UTC(year, month, day, hour, minute, second),
                        reason: commandParts.slice(3).join(" ")
                    });
                    message = `${target?.user.username} has been banned until ${new Date(ban.expiryDate).toDateString()} for ${ban.reason}.`;
                    this.server.speak(message, false, "notifications", "ui/notify1.ogg");
                    this.server.speakmods(`${player.user.username} has banned ${target?.user.username} for ${ban.reason}, until ${new Date(ban.expiryDate).toString()}`, true, "staff", "ui/notify2.ogg");
                    target?.send(consts.channel_misc, "quit", {
                        message: `You have been banned until ${new Date(ban.expiryDate).toString()}. For ${ban.reason}`
                    });
                    if (target && target.user.IPBans) target.user.IPBans = target?.user.IPBans.concat([ban.IP]);
                    await target?.user.save()
                    break;
            case "mute":
                var target = this.server.get_by_username(commandParts[1]);
                if (target && !target.user.muted && player.moderator) {
                    var reason = commandParts.slice(2).join(" ");
                    target.user.muted = true;
                    target.speak(
                        `You have been muted by a moderator for ${reason}`,
                        true,
                        "staff alerts",
                        "ui/notify1.ogg"
                    );
                    player.user.log({
                        eventType: "mute",
                        eventData: {
                            actioner: player.user.username,
                            actioned: target.user.username,
                            reason: reason,
                        },
                    });
                    target.user.log({
                        eventType: "mute",
                        eventData: {
                            actioner: player.user.username,
                            actioned: target.user.username,
                            reason: reason,
                        },
                    });
                    this.server.speakmods(
                        `${player.user.username} just muted ${target.user.username} for ${reason}`,
                        true,
                        "staff",
                        "ui/notify2.ogg"
                    );
                }
                break;
            case "unmute":
                var target = this.server.get_by_username(commandParts[1]);
                if (target && target.user.muted && player.moderator) {
                    target.user.muted = false;
                    target.speak(
                        `You have been unmuted by a moderator`,
                        true,
                        "staff alerts",
                        "ui/notify1.ogg"
                    );
                    player.user.log({
                        eventType: "unmute",
                        eventData: {
                            actioner: player.user.username,
                            actioned: target.user.username,
                        },
                    });
                    target.user.log({
                        eventType: "unmute",
                        eventData: {
                            actioner: player.user.username,
                            actioned: target.user.username,
                        },
                    });
                    this.server.speakmods(
                        `${player.user.username} just unmuted ${target.user.username}`,
                        true,
                        "staff",
                        "ui/notify2.ogg"
                    );
                }
                break;
            case "mc":
            case "mapchat":
                this.events.map_chat.bind(this)(player.peer, {
                    message: commandParts.slice(1).join(" "),
                });
                break;
            case "nickname":
            case "n":
                var nickname = commandParts.slice(1).join(" ");
                if (
                    nickname.length >= 3 &&
                    nickname.length <= 26 &&
                    player.user.nickname != nickname
                ) {
                    player.user.log({
                        eventType: "nickname",
                        eventData: {
                            first: player.user.nickname,
                            second: nickname,
                        },
                    });
                    player.user.nickname = nickname;
                    this.server.speak(
                        `${player.user.username} has changed their nickname to ${player.user.nickname}`,
                        false,
                        "notifications"
                    );
                    player.save();
                } else {
                    player.speak("invalid length");
                }
                break;
            case "create_behavior":
                if (player.builder) {
                    let behaviorName = commandParts[1];
                    if (behaviorName) {
                        const behaviorData = commandParts.slice(2).join(" ");
                        if (behaviorData) {
                            parseBehaviorTreeNode(
                                parseBehaviorTreeXml(behaviorData),
                                new Blackboard(player)
                            );
                            this.server.database.behaviors.create({
                                name: behaviorName,
                                xmlData: behaviorData,
                            });
                        }
                    }
                }
            case "logs":
                if (player.moderator) {
                    try {
                        var query_string = commandParts
                            .slice(2)
                            .join(" ")
                            .trim()
                            .toLowerCase();
                        if (query_string.startsWith("where ")) {
                            query_string = query_string.replace("where ", "");
                        }
                        const filter = await parse_log_query(
                            this.server,
                            query_string
                        );
                        switch (commandParts[1].toLowerCase()) {
                            case "select":
                                const log_entries =
                                    await this.server.logs.query(filter);
                                if (log_entries) {
                                    let log_text = "";
                                    for (let log_entry of log_entries) {
                                        log_text += `${logged_entry_to_string(
                                            log_entry
                                        )}\n`;
                                    }
                                    player.send(consts.channel_misc, "copy", {
                                        data: log_text,
                                        message: `Matched ${log_entries.length} entries. Copied to clipboard`,
                                    });
                                }
                                player.user.log({
                                    eventType: "log_access",
                                    eventData: {
                                        query: query_string,
                                    },
                                });
                                break;
                            case "count":
                                player.speak(
                                    `Matched ${await this.server.logs.countLogs(
                                        filter
                                    )}`
                                );
                        }
                    } catch (err) {
                        player.speak((err as Error).message);
                    }
                }
        }
    }
}

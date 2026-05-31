import consts from "./consts";
import * as string_utils from "./string_utils";
import * as random from "./random";
import zomby from "./objects/zomby";
import hellhound from "./objects/hellhound";
import game from "./game_mode";
import character from "./character";
import WorldMap from "./world_map";
import Server from "./networking";
import Player from "./objects/player";
import MaxAmmoPowerup from "./powerups/max_ammo";
import Powerup from "./powerups/powerup";
import LongtimePowerup from "./powerups/long_time_powerup";
import DoublePointsPowerup from "./powerups/double_points";
import InstakillPowerup from "./powerups/instakill";
import TickExecutor from "./tick_executor";
import NukePowerUp from "./powerups/nuke";
import Timer from "./timer";
export default class Zomby_game extends game {
    round_sounds_path: string;
    possible_powerups: (typeof Powerup)[] = [
        MaxAmmoPowerup,
        DoublePointsPowerup,
        InstakillPowerup,
        NukePowerUp,
    ];
    current_long_time_powerups: LongtimePowerup[] = [];
    gotten_powerups: number;
    dog_round: boolean;
    is_looping: boolean;
    round: number = 0;
    current_zombies: number = 0;
    total_zombies: number = 0;
    max_zombies: number = 0;
    killed_zombies: number = 0;
    double_points: boolean = false;
    instakill: boolean = false;
    protected tickExecutor: TickExecutor;
    spawn_clock: Timer = new Timer();
    get spawn_interval(): number {
        return Math.max(1500, 5000 - (this.round - 1) * 300);
    }
    constructor(server: Server, owner: Player, name: string, map: WorldMap) {
        super(server, owner, name, map);
        this.zomby_game = true;
        this.round_sounds_path = `rounds`;
        var self = this;
        this.gotten_powerups = 0;
        this.setup_round(1);
        this.dog_round = false;
        this.killed_zombies = 0;
        this.is_looping = false;
        this.tickExecutor = new TickExecutor(this.server, this.loop.bind(this));
    }
    format_scores_as_string() {
        var scores_string: string[] = [];
        for (var [player, score] of Object.entries<Record<string, any>>(
            this.scores
        )) {
            scores_string.push(`${player}: ${score.kills} kills`);
        }
        return string_utils.array_to_string(
            scores_string,
            "Total kills per player: ",
            scores_string[0],
            "and"
        );
    }
    add_player(player: Player, speak = true) {
        super.add_player(player, speak);
        player.character = new character(
            this.server,
            player,
            this.zomby_character_names.pop() ?? ""
        );
        this.scores[player.name].kills = 0;
        this.scores[player.name].points = 0;
        return true;
    }
    remove_player(player: Player, speak = true, destroy_if_empty = true) {
        super.remove_player(player, speak, destroy_if_empty);
        if (player.character) {
            this.zomby_character_names.push(player.character.name);
            random.shuffle_array(this.zomby_character_names);
        }
        player.character = undefined;
    }
    /// `powerup_list` is meant to only be set when you want to limit the chosen powerups.
    async randomize_powerup(
        percentage = 2,
        powerup_list?: (typeof Powerup)[]
    ): Promise<void> {
        if (this.gotten_powerups > 4) return;
        if (random.random_number(0, 100) <= percentage) {
            powerup_list = [...(powerup_list ?? this.possible_powerups)]; // make a copy
            random.shuffle_array(powerup_list);
            for (let chosen_powerup_type of powerup_list) {
                const chosen_powerup = new chosen_powerup_type(this);
                if (chosen_powerup instanceof LongtimePowerup) {
                    if (this.is_longtime_powerup_active(chosen_powerup_type)) {
                        continue; // Skip this powerup if it's already active
                    }
                    this.add_long_time_powerup(chosen_powerup);
                }
                chosen_powerup.activate();
                this.gotten_powerups++;
                break;
            }
        }
    }
    is_longtime_powerup_active(powerup_type: typeof Powerup): boolean {
        return this.current_long_time_powerups.some(
            (powerup) => powerup instanceof powerup_type
        );
    }
    add_long_time_powerup(powerup: LongtimePowerup): void {
        this.current_long_time_powerups.push(powerup);
    }
    remove_long_time_powerup(powerup: LongtimePowerup): void {
        this.current_long_time_powerups.splice(
            this.current_long_time_powerups.indexOf(powerup),
            1
        );
    }

    revive_all() {
        for (var i of this.players) {
            i.revive(true);
        }
    }
    start(): void {
        super.start();
        this.players.forEach((player) => player.reset_to_defaults());
        this.tickExecutor.start();
    }
    end() {
        this.started = false;
        this.speak(
            `Game over! ${this.format_scores_as_string()}`,
            true,
            "match",
            "rounds/gameover.ogg"
        );
        for (const player of this.players) {
            player.user.log({
                eventType: "match_over",
                eventData: {
                    name: this.name,
                    player_count: this.players.size- 1,
                },
            });
        }
        this.destroy();
    }
    get_dead_players(): number {
        var dead_players = 0;
        for (var i of this.players) {
            if (i.dead) dead_players++;
        }
        return dead_players;
    }
    setup_round(round: number, is_dog_round = false) {
        this.round = round;
        this.killed_zombies = 0;
        if (is_dog_round) {
            this.dog_round = true;
            this.current_zombies = 0;
            this.total_zombies = this.players.size;
            this.max_zombies = 1;
        } else {
            this.current_zombies = 0;
            this.total_zombies = this.calculate_zombies_amount(round);
            this.max_zombies = 24;
        }
    }
    async loop() {
        if (this.destroied) return;
        const powerups_to_remove: LongtimePowerup[] = [];
        for (let powerup of this.current_long_time_powerups) {
            if (
                !powerup.is_active ||
                powerup.active_timer.elapsed >= powerup.powerup_time
            ) {
                await powerup.deactivate();
                powerups_to_remove.push(powerup);
            }
        }
        powerups_to_remove.forEach(this.remove_long_time_powerup, this);
        if (this.total_zombies <= 0 && this.current_zombies <= 0) {
            await this.next_round();
        }
        if (this.current_zombies < this.max_zombies && this.total_zombies > 0) {
            if (this.spawn_clock.elapsed >= this.spawn_interval) {
                this.spawn_clock.restart();
                return this.spawn_zomby();
            }
        }
    }
    spawn_zomby(): void {
        var location = this.map.get_zomby_spawn();
        if (this.dog_round) {
            new hellhound(
                this.server,
                location.x,
                location.y,
                location.z,
                1000 * this.round,
                this.map
            );
        } else {
            new zomby(
                this.server,
                this.map,
                this.calculate_hp(this.round),
                this.calculate_damage(this.round),
                location.x,
                location.y,
                location.z
            );
        }
    }
    async next_round(): Promise<void> {
        this.gotten_powerups = 0;
        if (this.dog_round) {
            this.randomize_powerup(100);
            this.map.playersQuadtree.each((i) => i.set_hp(100));
        }
        var sound = this.dog_round
            ? `${this.round_sounds_path}/dog/end.ogg`
            : `${this.round_sounds_path}/${this.map.round_sounds}/end.ogg`;
        this.dog_round = false;
        this.speak(
            `End of round ${this.round}! ${this.format_scores_as_string()}`,
            false,
            "match",
            sound
        );
        await this.server.sleep_for(10000);
        this.revive_all();
        var is_dog_round = false;
        if ((this.round + 1) % 3 === 0) {
            is_dog_round = random.random_number(1, 100) <= 25;
        }
        var sound = is_dog_round
            ? `${this.round_sounds_path}/dog/start.ogg`
            : `${this.round_sounds_path}/${this.map.round_sounds}/start.ogg`;
        this.speak(`Round ${this.round + 1}!`, false, "match", sound);
        if (is_dog_round) await this.server.sleep_for(12500);
        for (var i of this.players) {
            var activity = {
                round: this.round,
                character: i.character?.char_name,
                map: this.map.mapName,
                party_id: this.owner.user.username + "'s match",
                size: this.players.size,
            };
            i.send(consts.channel_misc, "update_activity", activity);
        }
        this.setup_round(this.round + 1, is_dog_round);
    }
    calculate_damage(round: number): number {
        if (round < 10) {
            return 30;
        } else if (round < 30) {
            return 50;
        } else if (round < 50) {
            return 75;
        } else {
            return 90;
        }
    }
    calculate_hp(round: number): number {
        if (round < 10) {
            return 100 * round + 50;
        } else {
            var hp = 950;
            for (let i = 0; i != round - 9; i++) {
                hp = hp * 1.1;
            }
            return hp;
        }
    }
    calculate_zombies_amount(round: number): number {
        var amount = 1;
        if (this.players.size== 1) {
            amount =
                0.000058 * round ** 3 +
                0.074032 * round ** 2 +
                0.718119 * round +
                14.738699;
        } else if (this.players.size== 2) {
            amount =
                0.000054 * round ** 3 +
                0.169717 * round ** 2 +
                0.541627 * round +
                15.917041;
        } else if (this.players.size== 3) {
            amount =
                0.000169 * round ** 3 +
                0.238079 * round ** 2 +
                1.307276 * round +
                21.291046;
        } else if (this.players.size== 4) {
            amount =
                0.000225 * round ** 3 +
                0.314314 * round ** 2 +
                1.835712 * round +
                27.596132;
        }
        return amount;
    }
    calculate_max_zombies(round: number): number {
        var amount = 24 * (this.players.size* 6);
        if (round <= 4) {
            amount = amount * 0.6;
        }
        return amount;
    }
    destroy(): void {
        if (!this.destroied) {
            this.tickExecutor.cancel();
            this.players.forEach((player) => player.reset_to_defaults());
            this.revive_all();
            super.destroy();
            this.map.destroy_objects();
        }
    }
}

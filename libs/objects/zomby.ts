import * as movement from "../movement";
import * as random from "../random";
import logger from "../logger";
import tracker, { Point } from "../tracker";
import timer from "../timer";
import entity from "./entity";
import Game from "../game_mode";
import Zomby_game from "../zomby_game";
import WorldMap from "../world_map";
import Server from "../networking";
import Game_object from "./object";
import Player from "./player";
import Window from "./window";
import Entity from "./entity";
import window from "./window";
import Grenade_entity from "./grenade";
import Tracker from "../tracker";
export default class Zomby extends entity {
    points_reward: number;
    idel_timer: timer;
    idel_time: number;
    damage: number;
    zomby: boolean;
    powerup_chance: number;
    volume: number;
    destroy_time: number;
    audio_path: string;
    dead: boolean;
    attack_timer: timer;
    check_timer: timer;
    movement_time: number;
    range: number;
    attack_time: number;
    check_time: number;
    first: boolean;
    tracking?: Tracker;
    sound_path: string;
    cry_timer: timer;
    stuck_timer: timer;
    stuck_last_x: number;
    stuck_last_y: number;
    constructor(
        server: Server,
        map: WorldMap,
        hp: number,
        damage: number,
        x: number,
        y: number,
        z: number
    ) {
        super({
            server: server,
            map: map,
            name: `zomby${server.get_id()}`,
            game: map.game,
            hp: hp,
            x: x,
            y: y,
            z: z,
        });
        if (this.game instanceof Zomby_game) {
            this.game.current_zombies++;
            this.game.total_zombies--;
        }
        this.points_reward = random.random_number(50, 110);
        this.idel_timer = new timer();
        this.idel_time = 30000;
        this.damage = random.random_number(damage - 3, damage + 3);
        this.zomby = true;
        this.powerup_chance = 2;
        this.volume = 80;
        this.destroy_time = 1000;
        this.movement_timer = new timer();
        this.audio_path = "entities/zomby";
        this.dead = false;
        this.attack_timer = new timer();
        this.check_timer = new timer();
        this.movement_time = random.random_number(600, 900);
        this.range = 1;
        this.attack_time = random.random_number(950, 2500);
        this.check_time = 13000;
        this.first = true;
        this.tracking = undefined;
        this.sound_path = "entities/zomby";
        this.cry_timer = new timer();
        this.stuck_timer = new timer();
        this.stuck_last_x = x;
        this.stuck_last_y = y;
    }
    cry(): void {
        this.play_sound(
            `${this.sound_path}/amb/`,
            false,
            this.volume,
            false,
            false,
            false,
            "vocal"
        );
    }
    death(object: Game_object): void {
        if (this.dead) return;
        super.death(object);
        if (this.game instanceof Zomby_game) this.game.killed_zombies = this.game.killed_zombies + 1;
        var player = object instanceof Grenade_entity ? object.owner : object;
        if (player instanceof Player && player.game instanceof Zomby_game) {
            player.play_direct(
                "ui/kill.ogg",
                false,
                80,
                false,
                false,
                "kill_success"
            );
            player.game.scores[player.name].kills++;
            player.game.scores[player.name].points +=
                this.points_reward * (player.game.double_points ? 2 : 1);
            if (random.random_number(0, 100) <= 35 && player.character)
                player.game.call_after(450, () => {
                    if (player instanceof Player) {
                        player.character?.play_sound("kill", 2500);
                    }
                });
        }
        this.dead = true;
        this.cry_timer.restart();
        this.play_sound(
            `${this.sound_path}/death/`,
            false,
            this.volume,
            false,
            false,
            false,
            "vocal"
        );
        var self = this;
        setTimeout(() => self.destroy(), this.destroy_time);
    }
    async attack(): Promise<boolean> {
        var target: Game_object | null = null;
        var targets = this.map.get_objects_at(
            {
                x: this.x - this.range,
                y: this.y - this.range,
                z: this.z,
                width: this.range * 2,
                height: this.range * 2,
            },
            true
        );
        if (targets && targets.length) {
            for (var i in targets) {
                let current_target = targets[i];
                // Apply condition if target is a closed, not being attacked Window OR a Player not being hit and not dead.
                if (
                    (current_target instanceof Window &&
                        !current_target.being_hit &&
                        !current_target.open) ||
                    (current_target instanceof Player &&
                        !current_target.being_hit &&
                        !current_target.dead)
                ) {
                    target = targets[i];
                    break;
                }
            }
            if (!target) return false;
            this.play_sound(
                `${this.sound_path}/attack`,
                false,
                this.volume,
                false,
                false,
                false,
                "vocal"
            );
            if (!this.dead && target && !target.dead) {
                this.idel_timer.restart();
                if (target instanceof Player) target.being_hit = true;
                await this.server.sleep_for(500);
                if (target.player)
                    target.play_sound(`${this.sound_path}/hit_player`);
                target.on_hit(this, this.damage);
                if (target instanceof Player) target.being_hit = false;
                return true;
            }
        }
        return false;
    }
    on_hit(object: Game_object, hp?: number, excludeme?: boolean): void {
        if (this.game instanceof Zomby_game) {
            if (this.game.instakill) {
                hp = this.hp;
            }
        }
        return super.on_hit(object, hp, excludeme);
    }
    move(
        x: number,
        y: number,
        z: number,
        play_sound?: boolean,
        mode?: string,
        excludeme?: boolean
    ): void {
        super.move(x, y, z, play_sound, mode, excludeme);
        this.idel_timer.restart();
    }
    async loop(): Promise<void> {
        if (this.dead) return;
        if (
            this.idel_timer.elapsed >= this.idel_time &&
            (!this.tracking ||
                (this.tracking &&
                    this.tracking.reversed &&
                    this.tracking.at_end()))
        ) {
            var location = this.map.get_zomby_spawn();
            logger.info("zombie", `${this.name} idle teleport to spawn`, { x: location.x, y: location.y });
            this.move(location.x, location.y, location.z, false);
        }
        if (this.tracking && this.attack_timer.elapsed >= this.attack_time) {
            this.attack_timer.restart();
            await this.attack();
        }
        if (
            (this.tracking &&
                !this.tracking.reversed &&
                this.tracking.target.dead) ||
            (this.tracking &&
                this.tracking.target instanceof Player &&
                !this.tracking.target.game)
        ) {
            logger.info("zombie", `${this.name} target lost, seeking new`, { target: this.tracking.target.name });
            this.tracking.destroy();
            this.tracking = undefined;
            this.check_timer.restart();
            await this.find_target();
            return;
        }
        if (this.cry_timer.elapsed >= random.random_number(5639, 23000)) {
            this.cry_timer.restart();
            this.cry();
        }
        if (this.stuck_timer.elapsed >= 20000) {
            this.stuck_timer.restart();
            if (
                this.tracking &&
                !this.tracking.reversed &&
                Math.abs(this.x - this.stuck_last_x) < 1 &&
                Math.abs(this.y - this.stuck_last_y) < 1
            ) {
                logger.warn("zombie", `${this.name} stuck, re-pathing`, { x: this.x, y: this.y, target: this.tracking.target.name });
                this.tracking.destroy();
                this.tracking = undefined;
                this.check_timer.restart();
                await this.find_target();
                return;
            }
            this.stuck_last_x = this.x;
            this.stuck_last_y = this.y;
        }
        if (
            this.first ||
            (this.check_timer.elapsed >= this.check_time &&
                this.tracking &&
                this.tracking.reversed) ||
            (this.check_timer.elapsed >= this.check_time &&
                this.tracking &&
                !this.tracking.reversed &&
                this.tracking.at_end()) ||
            (this.check_timer.elapsed >= this.check_time && !this.tracking)
        ) {
            this.first = false;
            this.check_timer.restart();
            await this.find_target();
            return;
        }
        if (
            this.tracking &&
            !this.tracking.at_end() &&
            this.movement_timer.elapsed >= this.movement_time
        ) {
            this.movement_timer.restart();
            var next_step = this.tracking.next() as Point;
            next_step.z = next_step.z ?? this.z;
            this.move(next_step.x, next_step.y, next_step.z, true, "walk");
        }
    }
    async find_target(): Promise<void> {
        var path: Point[] | null = null;
        var targets: Entity[] = [];
        this.map.playersQuadtree.each((i) => {
            targets.push(i);
        });
        for (var i of this.map.get_objects_at(
            {
                x: this.x - 20,
                width: 40,
                y: this.y - 20,
                height: 40,
                z: this.z,
                max_z: this.z,
            },
            false
        )) {
            if (i instanceof Window && !i.open) {
                targets.push(i);
            }
        }
        targets = sort_targets_for_ai(this, targets);
        for (let i of targets) {
            if (
                i.dead ||
                (i instanceof window && i.open) ||
                i.listenerCount("move") >= 6
            )
                continue;
                try {
                    var x = Math.trunc(i.x);
                    var y = Math.trunc(i.y);
                    var z = Math.trunc(i.z);
                    if (this.map.is_unwalkable(this.map, x, y, this.z)) {
                        if (!this.map.is_unwalkable(this.map, x + 1, y, this.z))
                            x = x + 1;
                        else if (
                            !this.map.is_unwalkable(this.map, x - 1, y, this.z)
                        )
                            x = x - 1;
                        if (!this.map.is_unwalkable(this.map, x, y + 1, this.z))
                            y = y + 1;
                        else if (
                            !this.map.is_unwalkable(this.map, x, y - 1, this.z)
                        )
                            y = y - 1;
                    }
                    path = await this.map.find_path(
                        Math.trunc(this.x),
                        Math.trunc(this.y),
                        Math.trunc(this.z),
                        x,
                        y,
                        z
                    );
                    if (path && path.length) {
                        if (this.tracking) this.tracking.destroy();
                        this.tracking = new tracker(this.server, this, i, path);
                        this.idel_timer.restart();
                        logger.info("zombie", `${this.name} tracking ${i.name}`, { steps: path.length });
                        return;
                    }
                } catch (err) {
                    logger.error("zombie", `${this.name} pathfind error`, String(err));
                    continue;
                }
        }
        logger.warn("zombie", `${this.name} no reachable target found`, { x: this.x, y: this.y });
    }
    destroy(random_powerup = true): void {
        super.destroy();
        if (this.tracking) this.tracking.destroy();
        if (this.game instanceof Zomby_game) {
            this.game.current_zombies--;
            if (random_powerup)
                this.game?.randomize_powerup(this.powerup_chance);
        }
    }
}
/// sorts targets based on distance, then health (if applicable), preferring players over other objects.
export function sort_targets_for_ai(ref: Entity, targets: Entity[]): Entity[] {
    return targets
        .filter((t) => !t.dead) // Filter out dead targets
        .sort((a, b) => {
            const scoreA = calculateScore(ref, a);
            const scoreB = calculateScore(ref, b);
            // higher score first
            if (scoreA < scoreB) {
                return 1;
            } else if (scoreA > scoreB) {
                return -1;
            } else {
                return 0;
            }
        });
}
function calculateScore(ref: Entity, target: Entity): number {
    const WEIGHT_DISTANCE = 0.3;
    const WEIGHT_HEALTH = 0.3;
    const WEIGHT_ENTITY_TYPE = 0.15;
    const WEIGHT_TRACKING_COUNT = 0.25;
    let distanceScore = 0;
    let healthScore = 0;
    let entityTypeScore = 0;
    let trackingScore = 0;
    // closer = higher score
    const distance = movement.get_distance(ref, target);
    distanceScore = 1 / (distance + 1); // Adding 1 to avoid division by zero
    // lower health = higher score
    healthScore = 1 / (target.hp + 1);
    // prefer players
    if (target instanceof Player) {
        entityTypeScore = 1;
    }
    // Higher tracking count = lower score
    const trackingCount = target.listenerCount("move");
    trackingScore = 1 / (trackingCount + 1);
    const totalScore =
        WEIGHT_DISTANCE * distanceScore +
        WEIGHT_HEALTH * healthScore +
        WEIGHT_ENTITY_TYPE * entityTypeScore +
        WEIGHT_TRACKING_COUNT * trackingScore;
    return totalScore;
}

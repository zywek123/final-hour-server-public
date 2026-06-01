import consts from "./consts";
import Server from "./networking";
import Entity from "./objects/entity";
import Player from "./objects/player";
import Weapon from "./weapon";
export default class Weapon_manager {
    server: Server;
    owner: Entity;
    weapons: Weapon[];
    active_weapon: Weapon | null;
    constructor(server: Server, owner: Entity) {
        this.server = server;
        this.owner = owner;
        this.weapons = [];
        this.active_weapon = null;
    }
    add(w: Weapon, send = true) {
        this.weapons.push(w);
        if (this.owner instanceof Player && send)
            this.owner.send(consts.channel_weapons, "add_weapon", w.get_data());
    }
    modify(
        num: number,
        data: { ammo: number; reserved_ammo: number },
        send = true
    ) {
        try {
            Object.assign(this.weapons[num], data);
            if (this.owner instanceof Player && send) {
                this.owner.send(consts.channel_weapons, "modify_weapon", {
                    num: num,
                    data: data,
                });
            }
        } catch (err) {}
    }
    clear(send = true) {
        this.weapons = [];
        this.active_weapon = null;
        if (this.owner instanceof Player && send) {
            this.owner.send(consts.channel_weapons, "clear_weapons", {});
        }
    }
    replace(weapon: Weapon, num: number, send = true): void {
        num = num == -1 ? this.weapons.indexOf(this.active_weapon as Weapon) : num;
        this.weapons[num] = weapon;
        if (this.owner instanceof Player && send)
            this.owner.send(consts.channel_weapons, "replace_weapon", {
                weapon_data: weapon.get_data(),
                num: num,
            });
    }
    switch_weapon(num: number) {
        if (!Number.isInteger(num) || num < 0 || num >= this.weapons.length) return;
        this.active_weapon = this.weapons[num];
    }
    fire(angle = 0, pitch = 0) {
        if (this.active_weapon) {
            this.active_weapon.fire(angle, pitch);
        }
    }
    find_by_name(name: string) {
        for (let i of this.weapons) {
            if (i.name == name) {
                return i;
            }
        }
        return null;
    }
    reload() {
        if (this.active_weapon) {
            this.active_weapon.reload();
        }
    }
}

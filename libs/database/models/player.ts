import {
    Sequelize,
    DataTypes,
    Model,
    InferAttributes,
    InferCreationAttributes,
    CreationOptional,
    NonAttribute,
} from "@sequelize/core";
import {
    Attribute,
    PrimaryKey,
    AutoIncrement,
    HasMany,
    NotNull,
    Default,
    Table,
} from "@sequelize/core/decorators-legacy";
import Server from "../../networking";
import { LogEntry, LogQuery, LoggedEntry } from "./log_types";
import Log from "./log";
import Ticket from "./tickets";
import { dataTypeClassOrInstanceToInstance } from "@sequelize/core/_non-semver-use-at-your-own-risk_/dialects/abstract/data-types-utils.js";
import Player from "../../objects/player";
import IPBan from "./ipbans";
@Table({
    indexes: [
        { unique: true, fields: ["username"] },
        { unique: true, fields: ["normalized_username"] },
    ],
})
export default class User extends Model<
    InferAttributes<User>,
    InferCreationAttributes<User>
> {
    @Attribute(DataTypes.INTEGER)
    @PrimaryKey
    @AutoIncrement
    declare id: CreationOptional<number>;
    @HasMany(() => Ticket, {
        foreignKey: "user_id",
    })
    declare tickets: NonAttribute<Ticket[]>;
    @Attribute(DataTypes.STRING)
    @NotNull
    declare username: string;
    @Attribute(DataTypes.STRING)
    @NotNull
    declare normalized_username: string;
    @Attribute(DataTypes.STRING)
    @NotNull
    declare password: string;
    @Attribute(new DataTypes.STRING({ length: 26 }))
    @NotNull
    declare nickname: string;
    @Attribute(DataTypes.BOOLEAN)
    @Default(false)
    @NotNull
    declare muted: CreationOptional<boolean>;
    @Attribute(DataTypes.BOOLEAN)
    @Default(false)
    @NotNull
    declare permban: CreationOptional<boolean>;
    @Attribute(DataTypes.BIGINT)
    @Default(0)
    @NotNull
    declare tempbanExpiry: CreationOptional<number>;
    @Attribute(DataTypes.BOOLEAN)
    @Default(false)
    @NotNull
    declare invisible: CreationOptional<boolean>;
    @Attribute(DataTypes.STRING)
    @Default("")
    @NotNull
    declare banReason: CreationOptional<String>;
    @Attribute(DataTypes.JSON)
    @Default([])
    @NotNull
    declare IPBans: CreationOptional<String[]>;
    @Attribute(DataTypes.JSON)
    @Default([])
    @NotNull
    declare IPList: CreationOptional<String[]>;
    @Attribute(DataTypes.JSON)
    @Default([])
    @NotNull
    declare MacAddressBans: CreationOptional<String[]>;
    @Attribute(DataTypes.JSON)
    @Default([])
    @NotNull
    declare MacAdressList: CreationOptional<String[]>;
    @Attribute(DataTypes.BOOLEAN)
    @Default(false)
    @NotNull
    declare moderator: CreationOptional<boolean>;
    @Attribute(DataTypes.BOOLEAN)
    @Default(false)
    @NotNull
    declare builder: CreationOptional<boolean>;
    @Attribute(DataTypes.JSON)
    @Default([])
    @NotNull
    declare off_msg_queue: CreationOptional<
        [string, boolean, string, string][]
    >;
    @Attribute(DataTypes.JSON)
    @Default([])
    @NotNull
    declare block_list: CreationOptional<string[]>;
    @Attribute(DataTypes.JSON)
    @Default([])
    @NotNull
    declare blocked_players: CreationOptional<string[]>;
    @Attribute(DataTypes.INTEGER)
    @Default(0)
    @NotNull
    declare high_kills: CreationOptional<number>;
    @Attribute(DataTypes.INTEGER)
    @Default(0)
    @NotNull
    declare high_points: CreationOptional<number>;
    @Attribute(DataTypes.INTEGER)
    @Default(0)
    @NotNull
    declare high_accuracy: CreationOptional<number>;
    log(entry: LogEntry): Promise<LoggedEntry> {
        entry.userId = this.id;
        return Log.createEntry(entry);
    }
    log_chat(
        chat_type:
            | "chat"
            | "map_chat"
            | "modchat"
            | "buildchat"
            | "conchat" = "chat",
        message: string = ""
    ) {
        return this.log({
            eventType: chat_type,
            eventData: { message: message, nickname: this.nickname },
        });
    }
    /// The `user` and `users` fields of the query will be ignored.
    queryLogs(filter?: LogQuery): Promise<LoggedEntry[]> {
        if (!filter) filter = {};
        filter.user = this.id;
        return Log.query(filter);
    }
    static async username_exists(username: string): Promise<boolean> {
        const user = await User.findOne({
            where: { normalized_username: username.toLowerCase() },
            attributes: ["username"],
        });
        return !!user;
    }
    static async get_by_username(username: string): Promise<User> {
        const user = await User.findOne({
            where: { normalized_username: username.toLowerCase() },
        });
        if (user) return user;
        throw Error("Requested a username that does not exist.");
    }
}

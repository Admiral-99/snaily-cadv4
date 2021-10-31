import { User, WhitelistStatus, Rank } from ".prisma/client";
import { JsonRequestBody } from "@tsed/schema";
import { Controller, BodyParams, Post, Res, Response } from "@tsed/common";
import { hashSync, genSaltSync, compareSync } from "bcrypt";
import { BadRequest, NotFound } from "@tsed/exceptions";
import { prisma } from "../../lib/prisma";
import { setCookie } from "../../utils/setCookie";
import { signJWT } from "../../utils/jwt";
import { Cookie } from "@snailycad/config";
import { findOrCreateCAD } from "../../lib/cad";
import { validate, AUTH_SCHEMA } from "@snailycad/schemas";

// expire after 5 hours
const AUTH_TOKEN_EXPIRES_MS = 60 * 60 * 1000 * 5;
const AUTH_TOKEN_EXPIRES_S = AUTH_TOKEN_EXPIRES_MS / 1000;

@Controller("/auth")
export class AuthController {
  @Post("/login")
  async login(@BodyParams() body: JsonRequestBody, @Res() res: Response) {
    const error = validate(AUTH_SCHEMA, body.toJSON(), true);
    if (error) {
      throw new BadRequest(error);
    }

    const user = await prisma.user.findUnique({
      where: {
        username: body.username,
      },
    });

    if (!user) {
      throw new NotFound("userNotFound");
    }

    if (user.whitelistStatus === WhitelistStatus.PENDING) {
      throw new BadRequest("whitelistPending");
    }

    if (user.whitelistStatus === WhitelistStatus.DECLINED) {
      throw new BadRequest("whitelistDeclined");
    }

    if (user.banned) {
      throw new BadRequest("userBanned");
    }

    const userPassword = user.tempPassword ?? user.password;
    const isPasswordCorrect = compareSync(body.get("password"), userPassword);
    if (!isPasswordCorrect) {
      throw new BadRequest("passwordIncorrect");
    }

    const jwtToken = signJWT({ userId: user.id }, AUTH_TOKEN_EXPIRES_S);
    setCookie({
      res,
      name: Cookie.Session,
      expires: AUTH_TOKEN_EXPIRES_MS,
      value: jwtToken,
    });

    if (user.tempPassword) {
      return res.json({ hasTempPassword: true });
    }

    return res.json({ userId: user.id });
  }

  @Post("/register")
  async register(@BodyParams() body: JsonRequestBody, @Res() res: Response) {
    const error = validate(AUTH_SCHEMA, body.toJSON(), true);
    if (error) {
      throw new BadRequest(error);
    }

    const existing = await prisma.user.findUnique({
      where: {
        username: body.username,
      },
    });

    if (existing) {
      throw new BadRequest("userAlreadyExists");
    }

    const userCount = await prisma.user.count();
    const salt = genSaltSync();

    const password = hashSync(body.get("password"), salt);

    const user = await prisma.user.create({
      data: {
        username: body.get("username"),
        password,
      },
    });

    const cad = await findOrCreateCAD({
      ownerId: user.id,
    });

    const extraUserData: Partial<User> =
      userCount <= 0
        ? {
            rank: Rank.OWNER,
            isDispatch: true,
            isLeo: true,
            isEmsFd: true,
            isSupervisor: true,
            isTow: true,
            whitelistStatus: WhitelistStatus.ACCEPTED,
          }
        : {
            isTow: !cad.towWhitelisted,
            rank: Rank.USER,
            whitelistStatus: cad.whitelisted ? WhitelistStatus.PENDING : WhitelistStatus.ACCEPTED,
          };

    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: extraUserData,
    });

    if (extraUserData.rank === Rank.USER && cad.whitelisted) {
      throw new BadRequest("whitelistPending");
    }

    const jwtToken = signJWT({ userId: user.id }, AUTH_TOKEN_EXPIRES_S);
    setCookie({
      res,
      name: Cookie.Session,
      expires: AUTH_TOKEN_EXPIRES_MS,
      value: jwtToken,
    });

    return { userId: user.id, isOwner: extraUserData.rank === Rank.OWNER };
  }
}

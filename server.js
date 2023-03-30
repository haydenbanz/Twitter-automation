const express = require("express");
let app = express();
app.set("trust proxy", 1);
const passport = require("passport");
const TwitterStrategy = require("@superfaceai/passport-twitter-oauth2");
const url = require("url");
const https = require("https");
const bodyParser = require("body-parser");
const TwitterApi = require("twitter-api-v2").TwitterApi;
const WebFinger = require("webfinger.js");
const sqlite = require("better-sqlite3");
const DB = require("better-sqlite3-helper");
const fs = require("fs");
const cookieSession = require("cookie-session");
const cors = require("cors");
const parser = require("xml2json");
const { decrypt, encrypt } = require("./encryption.js");
const { getApp, getFollowings, toToken } = require("./mastodon.js");
const fsp = require('fs/promises');

async function write_stats(amount) {
  fsp.appendFile('stats.csv', Date.now() + ',' + amount+'\n');
}

const webfinger = new WebFinger({
  webfist_fallback: false,
  tls_only: true,
  uri_fallback: true,
  request_timeout: 5000,
});

const sessionMiddleware = cookieSession({
  name: "session",
  keys: [process.env.SECRET],
  proxy: true,
  sameSite: "lax",
  saveUninitialized: false,
  secure: true,
  maxAge: 2 * 60 * 1000, //two hours because Twitter token is only valid for that long
});

// Telling passport that cookies are fine and there is no need for server side sessions
// https://github.com/LinkedInLearning/node-authentication-2881188/issues/2#issuecomment-1297496099
const regenerate = (callback) => {
  callback();
};
const save = (callback) => {
  callback();
};

const twitter_scopes = [
  "tweet.read",
  "users.read",
  "follows.read",
  "list.read",
];

passport.use(
  new TwitterStrategy(
    {
      clientID: process.env.TWITTER_CLIENT_ID,
      clientSecret: process.env.TWITTER_CLIENT_SECRET,
      callbackURL: process.env.PROJECT_DOMAIN.includes("http")
        ? process.env.PROJECT_DOMAIN
        : `https://${process.env.PROJECT_DOMAIN}.glitch.me/login/twitter/return`,
      clientType: "confidential",
    },
    (accessToken, refreshToken, profile, cb) => {
      profile["refreshToken"] = refreshToken;
      profile["accessToken"] = accessToken;

      if (accessToken) {
        try {
          const client = create_twitter_client(profile);
          client.v2
            .me({
              "user.fields": [
                "name",
                "description",
                "url",
                "location",
                "entities",
                "public_metrics",
              ],
              expansions: ["pinned_tweet_id"],
              "tweet.fields": ["text", "entities"],
            })
            .catch((err) => {
              cb(new Error(err));
            })
            .then((data) => {
              let user = data.data;
              let pinned_tweet;
              let urls = [];
              let pinnedTweetInclude;
              if (data.includes)
                pinnedTweetInclude =
                  "tweets" in data.includes ? data.includes.tweets[0] : null;

              if (pinnedTweetInclude) {
                pinned_tweet = pinnedTweetInclude.text;
                if (
                  "entities" in pinnedTweetInclude &&
                  "urls" in pinnedTweetInclude["entities"]
                ) {
                  pinnedTweetInclude["entities"]["urls"].map((url) =>
                    urls.push(url.expanded_url)
                  );
                }
              }

              "entities" in user && "url" in user.entities
                ? user.entities.url.urls.map((url) =>
                    urls.push(url.expanded_url)
                  )
                : null;

              "entities" in user &&
              "description" in user.entities &&
              "urls" in user.entities.description
                ? user.entities.description.urls.map((url) =>
                    urls.push(url.expanded_url)
                  )
                : null;

              profile = {
                _json: {
                  username: user.username,
                  name: user.name,
                  location: user.location,
                  description: user.description,
                  urls: urls,
                  pinned_tweet: pinned_tweet,
                  public_metrics: user.public_metrics,
                },
                id: profile.id,
                refreshToken: refreshToken,
                accessToken: accessToken,
              };

              return cb(null, profile);
            })
            .catch((err) => {
              cb(new Error(err));
            });
        } catch (err) {
          cb(new Error(err));
        }
      } else {
        cb(new Error("no tokens"));
      }
    }
  )
);

passport.serializeUser((user, cb) => {
  cb(null, user);
});

passport.deserializeUser((obj, cb) => {
  cb(null, obj);
});

app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.set("json spaces", 20);
app.use(cors({ origin: "*", methods: "GET", allowedHeaders: "Content-Type" }));
app.use((req, res, next) => {
  if (
    req.path == "/login/twitter/return" &&
    "oauth:twitter" in req.session == false
  ) {
    // catch empty return requests. probably because of 2FA login
    res.redirect("/actualAuth/twitter");
  } else {
    req.session.regenerate = regenerate;
    req.session.save = save;
  }
  next();
});
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});

// Define routes.
app.all("*", checkHttps);

app.get("/logoff", (req, res) => {
  //todo: clear localstorage in frontend
  req.session = null;
  res.clearCookie("session", { path: "/" });
  res.redirect("/");
});

app.get("/auth/twitter", (req, res) => {
  //delete old session cookie
  res.clearCookie("connect.sid", { path: "/" });
  "user" in req ? res.redirect("/") : res.redirect("/actualAuth/twitter");
});

app.get(
  "/actualAuth/twitter",
  passport.authenticate("twitter", {
    scope: twitter_scopes,
  })
);

app.get(
  "/login/twitter/return",
  passport.authenticate("twitter", {
    failureRedirect: "/",
  }),
  (req, res) => {
    req.session.save(() => {
      res.redirect("/#t");
    });
  }
);

/*app.get("/", (req, res) => {
  "code" in req.query
    ? res.redirect("/index.html#c=" + req.query.code)
    : res.redirect("/index.html");
});*/

app.get("/success.html", (req, res) => {
  // redirect people who come over an link for fedifinder-original

  res.redirect("/");
});

app.get(process.env.DB_CLEAR + "_all", (req, res) => {
  // visit this URL to reset the DB
  DB().run("DELETE from domains");
  res.redirect("/");
});

async function write_cached_files() {
  if (process.env.LOOKUP_SERVER) {
    // get known instances file from lookup server
    https.get(
      process.env.LOOKUP_SERVER + "/cached/known_instances.json",
      (res) => {
        let body = "";
        if (res.statusCode != 200) {
          console.log(res);
        }
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => {
          fs.writeFileSync("public/cached/known_instances.json", body);
          console.log(
            "New cached known_instances.json was created from " +
              process.env.LOOKUP_SERVER
          );
        });
        res.on("error", (err) => {
          console.log(err);
        });
      }
    );
  } else {
    let domains = {};
    let relevant_keys = [
      "part_of_fediverse",
      "openRegistrations",
      "local_domain",
      "software_name",
      "software_version",
      "users_total",
    ];
    let instances = await DB().query(
      "SELECT * FROM domains WHERE part_of_fediverse = 1"
    );

    instances.forEach((instance) => {
      domains[instance.domain] = {};
      relevant_keys.forEach((key) => {
        instance[key]
          ? (domains[instance.domain][key] = instance[key])
          : void 0;
      });
    });
    fs.writeFileSync(
      "public/cached/known_instances.json",
      JSON.stringify(domains, null, 2)
    );
    console.log("New cached known_instances.json was created from database.");
  }
}

app.get("/api/known_instances.json", (req, res) => {
  let data = DB().query("SELECT * FROM domains WHERE part_of_fediverse = 1");
  data.forEach((data) => {
    data["openRegistrations"] = data["openRegistrations"] ? true : false;
    data["part_of_fediverse"] = data["part_of_fediverse"] ? true : false;
  });
  res.json(data);
});

app.get(process.env.DB_CLEAR + "_cleanup", async (req, res) => {
  // visit this URL to remove timed out entries from the DB
  console.log(await remove_domains_by_part_of_fediverse(null));
  console.log(await remove_domains_by_part_of_fediverse(0));

  let to_remove = [
    500,
    501,
    503,
    504,
    301,
    302,
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
  ];
  to_remove.forEach((status) => remove_domains_by_status(status));
  res.send(`Removed ${JSON.stringify(to_remove, null, 4)}`);

  //db_to_log();
});

app.get("/api/check", async (req, res) => {
  // force update a single domain
  let domain = req.query.domain
    ? req.query.domain.match(/[a-zA-Z0-9\-\.]+\.[a-zA-Z]+/)
    : "";
  domain = domain ? domain[0].toLowerCase() : "";

  let handle = req.query.handle
    ? req.query.handle.match(/^@?[a-zA-Z0-9_\-]+@[a-zA-Z0-9\-\.]+\.[a-zA-Z]+$/)
    : "";
  handle = handle ? handle[0].replace(/^@/, "").toLowerCase() : "";

  domain = domain ? domain : handle ? handle.split("@").slice(-1)[0] : "";

  if (domain) {
    if ("force" in req.query) {
      if (process.env.LOOKUP_SERVER) {
        https
          .get(
            `${process.env.LOOKUP_SERVER}/api/check?handle=${domain}&domain=${
              handle ? handle : ""
            }&force`
          )
          .then((data) => res.json(data));
      } else {
        try {
          let info = await update_data(domain, handle, true);
          res.json(info);
        } catch (err) {
          console.log(err);
          res.json(err);
        }
      }
    } else res.json(await check_instance(domain, handle));
  } else res.json({ error: "not a handle or not a domain" });
});

app.get("/api/app", async (req, res) => {
  // send app id for a domain back

  let domain = req.query.domain
    ? req.query.domain.match(/[a-zA-Z0-9\-\.]+\.[a-zA-Z]+/)
    : "";
  domain = domain ? domain[0].toLowerCase() : "";

  let remote_domain = req.query.remote_domain
    ? req.query.remote_domain.match(/[a-zA-Z0-9\-\.]+\.[a-zA-Z]+/)
    : "";
  remote_domain = remote_domain ? remote_domain[0].toLowerCase() : "";

  if (domain && remote_domain) {
    let data = await getApp(domain, remote_domain);
    data
      ? data.working != 0
        ? res.json({ client_id: data.client_id })
        : res.json({})
      : res.json({});
  } else if (domain) {
    let data = await getApp(domain);
    data
      ? data.working != !0
        ? res.json({ client_id: data.client_id })
        : res.json({})
      : res.json({});
  } else res.json({ error: "not valid" });
});

app.get("/api/totoken", async (req, res) => {
  // send app id for a domain back

  let domain = req.query.domain
    ? req.query.domain.match(/[a-zA-Z0-9\-\.]+\.[a-zA-Z]+/)
    : "";
  domain = domain ? domain[0].toLowerCase() : "";

  let auth_domain = req.query.auth_domain
    ? req.query.auth_domain.match(/[a-zA-Z0-9\-\.]+\.[a-zA-Z]+/)
    : "";
  auth_domain = auth_domain ? auth_domain[0].toLowerCase() : "";

  if (auth_domain && domain && req.query.code) {
    let app = await getApp(auth_domain, true);
    let auth_token = await toToken(domain, app, req.query.code);
    res.json(auth_token);
  } else res.json({ error: "not valid" });
});

app.get(process.env.DB_CLEAR + "_wcache", async (req, res) => {
  // delete all records from the database and repopulate it with data from remote server
  await write_cached_files();
  res.redirect("/success");
});

app.get(process.env.DB_CLEAR + "_pop", async (req, res) => {
  // delete all records from the database and repopulate it with data from remote server
  DB().run("DELETE from domains");
  console.log("Populating the database with known domains");
  populate_db("https://fedifinder.glitch.me/api/known_instances.json");
  res.redirect("/success");
});

app.get(process.env.DB_CLEAR + "_popfresh", async (req, res) => {
  // visit this URL to remove timed out entries from the DB
  let source_url =
    "https://fedifinder-backup.glitch.me/api/known_instances.json";
  console.log(
    "Populating the database with new data for known domains from " + source_url
  );
  ("https://fedifinder.glitch.me/api/known_instances.json");
  populate_db(source_url, true);
  res.send(
    "Started to populate the database with new records from " + source_url
  );
});

const server = app.listen(process.env.PORT, () => {
  // listen for requests
  console.log("Your app is listening on port " + server.address().port);
});

// WARNING: THIS IS BAD. DON'T TURN OFF TLS
//process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// setup a new database
// using database credentials set in .env
DB({
  path: ".data/better-sqlite3.db",
  readonly: false,
  fileMustExist: false,
  WAL: true,
  migrate: {
    force: false,
    table: "migration",
    migrationsPath: __dirname + "/migrations",
  },
});

function create_twitter_client(user) {
  try {
    const client = new TwitterApi(user.accessToken);
    return client;
  } catch (err) {
    console.log("Error", err);
  }
}

function db_to_log() {
  // for debugging
  let instances = DB().query("SELECT * FROM domains");
  instances.forEach((instance) => {
    console.log(instance.domain + " " + instance.status);
  });
}

async function db_add(nodeinfo, force = false) {
  let domain = nodeinfo["domain"];
  if (force) {
    DB().replaceWithBlackList("domains", nodeinfo, []);
  } else {
    let data = await DB().queryFirstRow(
      "SELECT * FROM domains WHERE domain=?",
      domain
    );
    if (data) return data;
    else {
      try {
        DB().insert("domains", nodeinfo);
      } catch (err) {
        console.log(err);
      }
      return nodeinfo;
    }
  }
}

function db_remove(domain) {
  try {
    DB().delete("domains", { domain: domain });
  } catch (err) {
    console.log(err);
  }
}

async function remove_domains_by_part_of_fediverse(fediversy) {
  try {
    return await DB().delete("domains", { part_of_fediverse: fediversy });
  } catch (err) {
    console.log(err);
  }
}

function remove_domains_by_status(status) {
  try {
    let data = DB().delete("domains", { status: status });
    console.log(`${status} removed: ${data}`);
    return data;
  } catch (err) {
    console.log(err);
  }
}

async function update_data(domain, handle = null, force = false) {
  let local_domain, wellknown, nodeinfo, error;
  let part_of_fediverse = 0;

  // check host-meta for a webfinger endpoint -> that's used as the local_domain
  local_domain = await get_local_domain(domain);

  if (typeof local_domain === "object" && "status" in local_domain) {
    // ugly. if it is an object instead of a string, getting host-meta failed
    // try to get nodeinfo anyways
    wellknown = await get_nodeinfo_url(domain);

    if (wellknown == null || (wellknown && "status" in wellknown)) {
      // if host-meta failed, try to guess the webfinger url
      local_domain = await get_local_domain_from_guessed_webfinger(domain);

      if (typeof local_domain === "object" && "status" in local_domain) {
        // ugly. if it is an object instead of a string, getting host-meta failed
        // try to get nodeinfo anyways
        wellknown = await get_nodeinfo_url(domain);
        if (wellknown == null || (wellknown && "status" in wellknown)) {
          let nodeinfo = {
            domain: domain,
            part_of_fediverse: 0,
            retries: 1,
            status: local_domain.status,
          };
          db_add(nodeinfo, force);
          return nodeinfo;
        } else {
          part_of_fediverse = 1;
          wellknown = await get_nodeinfo_url(local_domain);
        }
      }
    } else {
      local_domain = null;
    }
  } else {
    // found a webfinger URL, so it's propably fediverse
    part_of_fediverse = 1;
    wellknown = await get_nodeinfo_url(local_domain);
  }

  if (wellknown && "nodeinfo_url" in wellknown) {
    let nodeinfo = await get_nodeinfo(wellknown.nodeinfo_url);

    if (nodeinfo) {
      if (local_domain) nodeinfo["local_domain"] = local_domain;
      nodeinfo["domain"] = domain;
      db_add(nodeinfo, force);
      return nodeinfo;
    }
  } else if (wellknown && "status" in wellknown) {
    // ugly. status points at problem with nodeinfo. it could still be part of the fediverse.
    let nodeinfo = {
      domain: domain,
      part_of_fediverse: part_of_fediverse,
      retries: 1,
      status: wellknown.status,
      local_domain: local_domain,
    };
    db_add(nodeinfo, force);
    return nodeinfo;
  } else if (local_domain != null)
    return { domain: domain, part_of_fediverse: 1, status: "no nodeinfo" };
  return { domain: domain, part_of_fediverse: part_of_fediverse, retries: 1 };
}

async function populate_db(seed_url, refresh = false) {
  //https://fedifinder.glitch.me/api/known_instances.json
  https
    .get(seed_url, (res) => {
      let body = "";
      if (res.statusCode != 200) {
        console.log(res);
      }
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => {
        if (body.startsWith("<") === false) {
          try {
            let data = JSON.parse(body);
            if (refresh) {
              data.forEach((instance) => {
                //update_data
                check_instance(instance.domain);
              });
            } else {
              data.forEach((item) => {
                delete item.createdAt;
                delete item.updatedAt;
                delete item.localComments;
                item.part_of_fediverse = item.part_of_fediverse ? 1 : 0;
                item.openRegistrations = item.openRegistrations ? 1 : 0;
              });
              let count = DB().insert("domains", data);
              console.log(
                "DB successfully populated " +
                  count +
                  " entries from " +
                  seed_url
              );
            }
          } catch (err) {
            console.log(err);
          }
        }
      });
    })
    .on("error", (err) => {
      console.log(err);
      //todo: resolve unknown status
    });
}

async function check_instance(domain, handle = null) {
  // retrieve info about a domain
  let data = await DB().queryFirstRow(
    "SELECT * FROM domains WHERE domain=?",
    domain
  );
  if (data) {
    return data;
  } else {
    // no cached info -> get new info
    let new_data = await update_data(domain, handle);
    return new_data;
  }
}

function get_webfinger(handle) {
  // get webfinger data for a handle
  return new Promise((resolve) => {
    webfinger.lookup(encodeURI(handle), (err, info) => {
      if (err) {
        console.log("error: ", err.message);
        resolve(null);
      } else {
        resolve(info);
      }
    });
  }).catch((err) => {
    console.log(err);
  });
}

async function url_from_handle(handle) {
  // checks if webfinger exists for a handle and returns the first href aka webadress
  handle = handle.replace(/^@/, "");
  try {
    let data = await get_webfinger(handle);
    if (data) {
      return data["object"]["links"][0]["href"];
    } else return false;
  } catch (err) {
    console.log(err);
    return false;
  }
}

async function get_local_domain_from_guessed_webfinger(
  host_domain,
  redirect_count = 0
) {
  // get local domain from webfinger in host-meta
  return new Promise((resolve) => {
    let options = {
      method: "GET",
      host: encodeURI(host_domain),
      path: "/.well-known/webfinger",
      timeout: 5000,
      headers: {
        "User-Agent": "fedifinder.glitch.me",
      },
    };

    https
      .get(options, (res) => {
        if (res.statusCode != 400) {
          if (
            (res.statusCode == 302 ||
              res.statusCode == 301 ||
              res.statusCode == 303) &&
            redirect_count <= 10 // limit redirects to prevent circular ones
          ) {
            redirect_count += 1;
            resolve(
              get_local_domain_from_guessed_webfinger(
                res.headers.location.split("/")[2],
                redirect_count
              )
            );
          } else {
            resolve({ status: res.statusCode });
          }
        } else {
          resolve(host_domain);
        }
      })
      .on("error", (err) => {
        //console.log(err);
        resolve({ status: err["code"] });
      });
  }).catch((err) => {
    console.log(err);
  });
}

async function get_local_domain(host_domain, redirect_count = 0) {
  // get local domain from webfinger in host-meta
  return new Promise((resolve) => {
    let options = {
      method: "GET",
      host: encodeURI(host_domain),
      path: "/.well-known/host-meta",
      timeout: 5000,
      headers: {
        "User-Agent": "fedifinder.glitch.me",
      },
    };

    https
      .get(options, (res) => {
        let body = "";
        if (res.statusCode != 200) {
          if (
            (res.statusCode == 302 ||
              res.statusCode == 301 ||
              res.statusCode == 303) &&
            redirect_count <= 10 // limit redirects to prevent circular ones
          ) {
            redirect_count += 1;
            resolve(
              get_local_domain(
                res.headers.location.split("/")[2],
                redirect_count
              )
            );
          } else {
            resolve({ status: res.statusCode });
          }
        } else {
          res.on("data", (d) => {
            body += d;
          });
          res.on("end", () => {
            if (body.startsWith("<") === true) {
              try {
                let data = parser.toJson(body, {
                  object: true,
                  reversible: false,
                  coerce: false,
                  sanitize: true,
                  trim: true,
                  arrayNotation: false,
                  alternateTextNode: false,
                });
                try {
                  resolve(data.XRD.Link.template.split("//")[1].split("/")[0]);
                } catch (err) {
                  resolve({
                    status: "no webfinger template in .well-known/host-meta",
                  });
                }
              } catch (err) {
                console.log("xml error: " + host_domain);
                resolve({ status: "well-known/host-meta broken" });
              }
            } else resolve({ status: ".well-known/host-meta not found" });
          });
        }
      })
      .on("error", (err) => {
        //console.log(err);
        resolve({ status: err["code"] });
        //todo: resolve unknown status
      });
  }).catch((err) => {
    console.log(err);
  });
}

async function get_nodeinfo_url(host_domain, redirect_count = 0) {
  // get url of nodeinfo json
  return new Promise((resolve) => {
    let options = {
      method: "GET",
      host: encodeURI(host_domain),
      json: true,
      path: "/.well-known/nodeinfo",
      timeout: 5000,
      headers: {
        "User-Agent": "fedifinder.glitch.me",
      },
    };

    https
      .get(options, (res) => {
        let body = "";
        if (res.statusCode != 200) {
          if (
            (res.statusCode == 302 ||
              res.statusCode == 301 ||
              res.statusCode == 303) &&
            redirect_count <= 10 // limit redirects to prevent circular ones
          ) {
            redirect_count += 1;
            resolve(
              get_nodeinfo_url(
                res.headers.location.split("/")[2],
                redirect_count
              )
            );
          }
        }
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => {
          if (body.startsWith("<") === false) {
            try {
              resolve({ nodeinfo_url: JSON.parse(body)["links"][0]["href"] });
            } catch (err) {
              //console.log(err)
              resolve(null);
            }
          } else resolve(null);
        });
      })
      .on("error", (err) => {
        //console.log(err);
        resolve({ status: err["code"] });
        //todo: resolve unknown status
      });
  }).catch((err) => {
    console.log(err);
  });
}

function get_nodeinfo(nodeinfo_url) {
  // get fresh nodeinfo and save to db
  return new Promise((resolve) => {
    const options = {
      headers: {
        "User-Agent": "fedifinder.glitch.me",
      },
      timeout: 5000,
    };
    https
      .get(encodeURI(nodeinfo_url), options, (res) => {
        let body = "";
        if (res.statusCode != 200) {
          resolve({ part_of_fediverse: 0 });
        }
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => {
          if (body.startsWith("<") === false) {
            try {
              let nodeinfo = JSON.parse(body);
              resolve({
                part_of_fediverse: 1,
                software_name: nodeinfo["software"]["name"],
                software_version: nodeinfo["software"]["version"],
                users_total:
                  "users" in nodeinfo["usage"] &&
                  "total" in nodeinfo["usage"]["users"]
                    ? nodeinfo["usage"]["users"]["total"]
                    : null, //todo handle unvailable counts
                users_activeMonth:
                  "users" in nodeinfo["usage"] &&
                  "activeMonth" in nodeinfo["usage"]["users"]
                    ? nodeinfo["usage"]["users"]["activeMonth"]
                    : null, //todo handle unvailable counts
                users_activeHalfyear:
                  "users" in nodeinfo["usage"] &&
                  "activeHalfyear" in nodeinfo["usage"]["users"]
                    ? nodeinfo["usage"]["users"]["activeHalfyear"]
                    : null, //todo handle unvailable counts
                localPosts:
                  "localPosts" in nodeinfo["usage"]
                    ? nodeinfo["usage"]["localPosts"]
                    : null, //todo handle unavailable counts
                openRegistrations: nodeinfo["openRegistrations"] ? 1 : 0,
              });
            } catch (err) {
              console.log(err);
              resolve({ part_of_fediverse: 0 });
            }
          }
        });
      })
      .on("error", (e) => {
        //console.log(e);
        resolve({ status: e["code"] });
        //console.log(nodeinfo_url);
        //console.error(e);
      });
  });
}

function checkHttps(req, res, next) {
  // protocol check, if http, redirect to https
  const forwardedProto = req.get("X-Forwarded-Proto");
  if (forwardedProto && forwardedProto.indexOf("https") != -1) {
    return next();
  } else {
    res.redirect("https://" + req.hostname + req.url);
  }
}

app.get("/api/getProfile", async (req, res) => {
  if ("user" in req) {
    res.json(req.user._json);
  } else {
    res.json({ error: "not logged in" });
  }
});

app.get("/api/lookupServer", async (req, res) => {
  if (process.env.LOOKUP_SERVER) {
    res.json({ lookup_server: process.env.LOOKUP_SERVER });
  } else {
    res.json({ error: "no lookup server" });
  }
});

app.get("/api/loadLists", async (req, res) => {
  if ("user" in req) {
    try {
      let client = create_twitter_client(req.user);
      let lists = [];

      // get lists owned by user
      const ownedLists = await client.v2.listsOwned(req.user.id, {
        "list.fields": ["member_count"],
      });
      for await (const list of ownedLists) {
        lists.push({
          name: list["name"],
          id_str: list["id"],
          member_count: list["member_count"],
        });
      }

      // get subscribed lists of user
      const followedLists = await client.v2.listFollowed(req.user.id, {
        "list.fields": ["member_count"],
      });
      for await (const list of followedLists) {
        lists.push({
          name: list["name"],
          id_str: list["id"],
          member_count: list["member_count"],
        });
      }
      res.json(lists);
    } catch (err) {
      res.json(err);
    }
  } else {
    res.json({ error: "not logged in" });
  }
});

app.get("/api/getList", async (req, res) => {
  let list_id;
  "listid" in req.query
    ? (list_id = req.query.listid)
    : res.json({ error: "no list provided" });
  if ("user" in req) {
    try {
      let client = create_twitter_client(req.user);
      let params = {
        max_results: 100,
        "user.fields": ["name", "description", "url", "location", "entities"],
        expansions: ["pinned_tweet_id"],
        "tweet.fields": ["text", "entities"],
      };
      "next_token" in req.query && req.query.next_token.length > 2
        ? (params["pagination_token"] = req.query.next_token)
        : void 0;

      const twitres = await client.v2.get(
        `lists/${req.query.listid}/members`,
        params,
        { fullResponse: true }
      );
      processData({ type: "list", list_id: list_id }, twitres, res);
    } catch (err) {
      res.json(err);
    }
  } else {
    res.json({ error: "not logged in" });
  }
});

app.get("/api/getFollowings", async (req, res) => {
  if ("user" in req) {
    try {
      let client = create_twitter_client(req.user);
      let params = {
        max_results: 1000,
        "user.fields": ["name", "description", "url", "location", "entities"],
        expansions: ["pinned_tweet_id"],
        "tweet.fields": ["text", "entities"],
      };
      "next_token" in req.query && req.query.next_token.length > 2
        ? (params["pagination_token"] = req.query.next_token)
        : void 0;
      const twitres = await client.v2.get(
        `users/${req.user.id}/following`,
        params,
        { fullResponse: true }
      );
      processData({ type: "followings" }, twitres, res);
    } catch (err) {
      res.json(err);
    }
  } else {
    res.json({ error: "not logged in" });
  }
});

app.get("/api/getFollowers", async (req, res) => {
  if ("user" in req) {
    try {
      let client = create_twitter_client(req.user);
      let params = {
        max_results: 1000,
        "user.fields": ["name", "description", "url", "location", "entities"],
        expansions: ["pinned_tweet_id"],
        "tweet.fields": ["text", "entities"],
      };
      "next_token" in req.query && req.query.next_token.length > 2
        ? (params["pagination_token"] = req.query.next_token)
        : void 0;
      const twitres = await client.v2.get(
        `users/${req.user.id}/followers`,
        params,
        { fullResponse: true }
      );
      processData({ type: "followers" }, twitres, res);
    } catch (err) {
      res.json(err);
    }
  } else {
    res.json({ error: "not logged in" });
  }
});

function processData(type, twitres, cb) {
  // extract information from API response and sent relevant parts to frontend
  let accounts = [];
  twitres.data.data.forEach((user) => {
    let urls = [];
    let pinned_tweet;

    if ("pinned_tweet_id" in user) {
      let pinnedTweetInclude = twitres.data.includes.tweets.find(
        (tweet) => tweet.id == user.pinned_tweet_id
      );
      if (pinnedTweetInclude) {
        pinned_tweet = pinnedTweetInclude.text;
        if (
          "entities" in pinnedTweetInclude &&
          "urls" in pinnedTweetInclude["entities"]
        ) {
          pinnedTweetInclude["entities"]["urls"].map((url) =>
            urls.push(url.expanded_url)
          );
        }
      }
    }

    "entities" in user && "url" in user.entities
      ? user.entities.url.urls.map((url) => urls.push(url.expanded_url))
      : null;

    "entities" in user &&
    "description" in user.entities &&
    "urls" in user.entities.description
      ? user.entities.description.urls.map((url) => urls.push(url.expanded_url))
      : "";

    accounts.push({
      username: user.username,
      name: user.name,
      location: user.location,
      description: user.description,
      urls: urls,
      pinned_tweet: pinned_tweet,
    });
  });

  let ratelimit_remaining = twitres.rateLimit.remaining;

  let next_token =
    "next_token" in twitres.data.meta ? twitres.data.meta.next_token : "";

  write_stats(accounts.length)
  
  cb.json({
    type: type,
    accounts: accounts,
    ratelimit_remaining: ratelimit_remaining,
    next_token: next_token,
  });
}

async function processRequests(type, data, cb) {
  // get accounts from Twitter and sent relevant parts to frontend
  let accounts = [];

  try {
    for await (const user of data) {
      let urls = [];
      let pinned_tweet;

      const pinnedTweetInclude = data.includes.pinnedTweet(user);

      if (pinnedTweetInclude) {
        pinned_tweet = pinnedTweetInclude.text;
        if (
          "entities" in pinnedTweetInclude &&
          "urls" in pinnedTweetInclude["entities"]
        ) {
          pinnedTweetInclude["entities"]["urls"].map((url) =>
            urls.push(url.expanded_url)
          );
        }
      }

      "entities" in user && "url" in user.entities
        ? user.entities.url.urls.map((url) => urls.push(url.expanded_url))
        : null;

      "entities" in user &&
      "description" in user.entities &&
      "urls" in user.entities.description
        ? user.entities.description.urls.map((url) =>
            urls.push(url.expanded_url)
          )
        : null;

      accounts.push({
        username: user.username,
        name: user.name,
        location: user.location,
        description: user.description,
        urls: urls,
        pinned_tweet: pinned_tweet,
      });
    }
    cb.json({ type: type, accounts: accounts });
  } catch (err) {
    console.log(err);
    cb.json({ type: type, accounts: accounts });
  }
}

async function tests() {
  //DB().run("DELETE from domains");
  console.log("Start tests");
  const assert = require("assert").strict;
  write_cached_files();

  const it = (description, function_to_test) => {
    try {
      function_to_test();
      console.log("\x1b[32m%s\x1b[0m", `\u2714 ${description}`);
    } catch (error) {
      console.log("\n\x1b[31m%s\x1b[0m", `\u2718 ${description}`);
      console.error(error);
    }
  };

  it("should get the nodeinfo URL", async () => {
    let data = await get_nodeinfo_url("lucahammer.com");
    assert(data.nodeinfo_url == "https://lucahammer.com/wp-json/nodeinfo/2.1");
  });

  it("should add an entry, update the entry, remove that entry based on retries", async () => {
    let added_instance = await db_add({ domain: "test.com", retries: 100 });
    assert(added_instance.domain == "test.com");

    let test_domain = DB().queryFirstRow(
      "SELECT * FROM domains WHERE domain=?",
      "test.com"
    );
    assert(test_domain.domain == "test.com");

    db_remove("test.com");
    let cleaned = DB().queryFirstRow(
      "SELECT * FROM domains WHERE domain=?",
      "test.com"
    );
    assert(cleaned == undefined);
  });

  it("should get no info about a non fediverse website", async () => {
    let info = await check_instance("google.com");
    assert(info.part_of_fediverse == 0);
  });

  it("should get new info about an instance and save to db", async () => {
    let info = await check_instance("lucahammer.com");
    assert(info.users_total == 1);
    info = await check_instance("lucahammer.com");
    assert(info.users_total == 1);
  });

  it("should get url from handle (webfinger)", async () => {
    let url = await url_from_handle("@luca@vis.social");
    assert("https://vis.social/@Luca" == url);
    url = await url_from_handle("luca@lucahammer.com");
    assert("https://lucahammer.com/author/luca" == url);
  });

  it("should encrypt and decrypt a string", () => {
    let message = "message";
    let encrypted = encrypt(message);
    assert(encrypted != message);
    assert(message == decrypt(encrypted));
  });

  it("get or create app for a mastodon instance", async () => {
    let app = await getApp("vis.social");
    assert(app.domain == "vis.social");
  });
}

write_cached_files();
//if (/dev|staging|localhost/.test(process.env.PROJECT_DOMAIN)) tests();
//DB().run("DELETE from mastodonapps");

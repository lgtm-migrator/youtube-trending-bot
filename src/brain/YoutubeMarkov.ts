import debug = require('debug');
import fs = require('fs');
import path = require('path');
import util = require('util');
const log = debug('brain');

import {
    createDictionaryFromInput,
    generateMessage,
    IMarkovMap,
    updateDictionaryFromInput,
} from '../markov';
import { fetchAllCommentsForVideo, fetchTrendingVideos } from '../youtube';

// Some constants that will help us limit how many comments we
// are fetching per day, so we don't hit the quota limit
const QUOTA_COST_PER_FETCH = 4; // 1 per video listing, 3 per comment fetching
const MAX_QUOTA_PER_DAY = 10000;
const COMMENTS_PER_BATCH = 100;
const MAX_COMMENTS_PER_DAY =
    (MAX_QUOTA_PER_DAY / QUOTA_COST_PER_FETCH) * COMMENTS_PER_BATCH;

const MAX_COMMENTS_PER_VIDEO = 100;

const MAX_VIDEOS_PER_UPDATE = 5;

const CHAIN_LENGTH = 2;

interface ISerializedStructure {
    map: IMarkovMap;
    harvestedYoutubeIDs: string[];
}

export default class YoutubeMarkov {
    private map: IMarkovMap;
    private harvestedYoutubeIDs: Set<string> = new Set<string>();

    /**
     * @param pathToFile    The path to persist the map to on disk
     */
    constructor(readonly apiKey: string, readonly pathToFile: string) {}

    public async initialise() {
        try {
            await this.loadMapFromStorage();
        } catch {
            log('Unable to load map from storage. Creating fresh one');
            this.map = createDictionaryFromInput('', CHAIN_LENGTH);
        }
    }

    public generateMessage() {
        return generateMessage(this.map);
    }

    public async updateMapFromYoutube() {
        log('Updating map from youtube');

        // Get the latest trending videos, not including ones we
        // have already processed, and limit it to MAX_VIDEOS_PER_UPDATE
        const trending = (await fetchTrendingVideos(this.apiKey))
            .filter(videoID => !this.harvestedYoutubeIDs.has(videoID))
            .slice(0, MAX_VIDEOS_PER_UPDATE);

        // Iterate through the trending videos, for each one fetch
        // our predetermined amount of comments and add them to our
        // dictionary.
        let commentsFetched = 0;
        for (const videoId of trending) {
            log(`Fetching comments from ${videoId}`);
            const comments = await fetchAllCommentsForVideo(
                videoId,
                this.apiKey,
                MAX_COMMENTS_PER_VIDEO,
            );
            commentsFetched += comments.length;
            log(`Fetched ${comments.length} comments`);

            updateDictionaryFromInput(
                comments.join('\n'),
                this.map,
                CHAIN_LENGTH,
            );
            this.harvestedYoutubeIDs.add(videoId);

            // Try not to go over our quota in the next fetch
            if (commentsFetched + MAX_COMMENTS_PER_VIDEO > MAX_COMMENTS_PER_DAY)
                break;
        }

        log(`Dictionary now contains ${Object.keys(this.map).length} keys`);
        log(`Dictionary KV ratio is now ${this.getKeyValueRatio()}`);
        this.saveMapToStorage();
    }

    public getKeyCount() {
        return Object.keys(this.map).length;
    }

    public getKeyValueRatio() {
        const totalValues = Object.values(this.map).reduce(
            (total, tokenArray) => (total += tokenArray.length),
            0,
        );
        return totalValues / this.getKeyCount();
    }

    private async loadMapFromStorage() {
        const readFile = util.promisify(fs.readFile);
        const json = await readFile(this.pathToFile, { encoding: 'utf8' });

        const data = JSON.parse(json) as ISerializedStructure;
        this.map = data.map;
        this.harvestedYoutubeIDs = new Set(data.harvestedYoutubeIDs);
        log(
            `markov file loaded from disk with [${
                Object.keys(this.map).length
            }] keys`,
        );
    }

    private async saveMapToStorage() {
        // Ensure the folder exists before we create it
        const dir = path.dirname(this.pathToFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
        }

        const data: ISerializedStructure = {
            harvestedYoutubeIDs: Array.from(this.harvestedYoutubeIDs),
            map: this.map,
        };

        const writeFile = util.promisify(fs.writeFile);
        await writeFile(this.pathToFile, JSON.stringify(data));
        log(`Saved markov file to disk at ${this.pathToFile}`);
    }
}

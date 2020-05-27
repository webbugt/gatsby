const path = require(`path`)
const isOnline = require(`is-online`)
const _ = require(`lodash`)
const fs = require(`fs-extra`)
const normalize = require(`./normalize`)
const fetchData = require(`./fetch`)
const { createPluginConfig, validateOptions } = require(`./plugin-options`)
const { downloadContentfulAssets } = require(`./download-contentful-assets`)
const { createClient } = require(`contentful`)
const conflictFieldPrefix = `contentful`

const CACHE_SYNC_KEY = `previousSyncData`
const CACHE_SYNC_TOKEN = `syncToken`

// restrictedNodeFields from here https://www.gatsbyjs.org/docs/node-interface/
const restrictedNodeFields = [
  `children`,
  `contentful_id`,
  `fields`,
  `id`,
  `internal`,
  `parent`,
]

exports.setFieldsOnGraphQLNodeType = require(`./extend-node-type`).extendNodeType

exports.onPreBootstrap = validateOptions
/***
 * Localization algorithm
 *
 * 1. Make list of all resolvable IDs worrying just about the default ids not
 * localized ids
 * 2. Make mapping between ids, again not worrying about localization.
 * 3. When creating entries and assets, make the most localized version
 * possible for each localized node i.e. get the localized field if it exists
 * or the fallback field or the default field.
 */

exports.sourceNodes = async (
  {
    actions,
    getNode,
    getNodes,
    createNodeId,
    store,
    cache,
    getCache,
    reporter,
  },
  pluginOptions
) => {
  const { createNode, deleteNode, touchNode } = actions
  const client = createClient({
    space: `none`,
    accessToken: `fake-access-token`,
  })
  const online = await isOnline()

  // If the user knows they are offline, serve them cached result
  // For prod builds though always fail if we can't get the latest data
  if (
    !online &&
    process.env.GATSBY_CONTENTFUL_OFFLINE === `true` &&
    process.env.NODE_ENV !== `production`
  ) {
    getNodes().forEach(node => {
      if (node.internal.owner !== `gatsby-source-contentful`) {
        return
      }
      touchNode({ nodeId: node.id })
      if (node.localFile___NODE) {
        // Prevent GraphQL type inference from crashing on this property
        touchNode({ nodeId: node.localFile___NODE })
      }
    })

    reporter.info(`Using Contentful Offline cache ⚠️`)
    reporter.info(
      `Cache may be invalidated if you edit package.json, gatsby-node.js or gatsby-config.js files`
    )

    return
  }

  const pluginConfig = createPluginConfig(pluginOptions)

  // add preview/sync capabilitly to token
  let syncToken = await cache.get(CACHE_SYNC_TOKEN)
  let previousSyncData = {
    assets: [],
    entries: [],
  }
  let cachedData = await cache.get(CACHE_SYNC_KEY)

  if (cachedData) {
    previousSyncData = cachedData
  }

  let {
    currentSyncData,
    contentTypeItems,
    defaultLocale,
    locales,
    space,
  } = await fetchData({
    syncToken,
    reporter,
    pluginConfig,
  })

  // Remove deleted entries and assets from cached sync data set
  previousSyncData.entries = previousSyncData.entries.filter(
    entry =>
      _.findIndex(
        currentSyncData.deletedEntries,
        o => o.sys.id === entry.sys.id
      ) !== -1
  )

  previousSyncData.assets = previousSyncData.assets.filter(
    asset =>
      _.findIndex(
        currentSyncData.deletedAssets,
        o => o.sys.id === asset.sys.id
      ) !== -1
  )

  // Merge cached data with new sync data
  // order is important here, fresh data first
  currentSyncData.entries = _.uniqBy(
    currentSyncData.entries.concat(previousSyncData.entries),
    `sys.id`
  )

  currentSyncData.assets = _.uniqBy(
    currentSyncData.assets.concat(previousSyncData.assets),
    `sys.id`
  )

  // Store a raw and unresolved copy of the data for caching
  const currentSyncDataRaw = { ...currentSyncData }

  // TODO run link resolution on the up to date data

  /*
   * on sync, we only get the synced data because there isn't enough data
   * we want to trick the SDK to merge the data
   * on initial sync, we save all the data
   * on subsequent syncs, we get the updated data; merge with the old data
   * if there are duplicate entries we take newest
   */
  const res = client.parseEntries({
    items: currentSyncData.entries,
    includes: {
      assets: currentSyncData.assets,
      entries: currentSyncData.entries,
    },
  })

  currentSyncData.entries = res.items

  const entryList = normalize.buildEntryList({
    currentSyncData,
    contentTypeItems,
  })

  // Remove deleted entries & assets.
  // TODO figure out if entries referencing now deleted entries/assets
  // are "updated" so will get the now deleted reference removed.

  function deleteContentfulNode(node) {
    const localizedNodes = locales
      .map(locale => {
        const nodeId = createNodeId(
          normalize.makeId({
            spaceId: space.sys.id,
            id: node.sys.id,
            currentLocale: locale.code,
            defaultLocale,
          })
        )
        return getNode(nodeId)
      })
      .filter(node => node)

    localizedNodes.forEach(node => {
      // touchNode first, to populate typeOwners & avoid erroring
      touchNode({ nodeId: node.id })
      deleteNode({ node })
    })
  }

  currentSyncData.deletedEntries.forEach(deleteContentfulNode)
  currentSyncData.deletedAssets.forEach(deleteContentfulNode)

  const existingNodes = getNodes().filter(
    n => n.internal.owner === `gatsby-source-contentful`
  )
  existingNodes.forEach(n => touchNode({ nodeId: n.id }))

  const assets = currentSyncData.assets

  reporter.info(`Updated entries ${currentSyncData.entries.length}`)
  reporter.info(`Deleted entries ${currentSyncData.deletedEntries.length}`)
  reporter.info(`Updated assets ${currentSyncData.assets.length}`)
  reporter.info(`Deleted assets ${currentSyncData.deletedAssets.length}`)
  console.timeEnd(`Fetch Contentful data`)

  // Update syncToken
  const nextSyncToken = currentSyncData.nextSyncToken

  await Promise.all([
    cache.set(CACHE_SYNC_KEY, currentSyncDataRaw),
    cache.set(CACHE_SYNC_TOKEN, nextSyncToken),
  ])
  // Create map of resolvable ids so we can check links against them while creating
  // links.
  const resolvable = normalize.buildResolvableSet({
    existingNodes,
    entryList,
    assets,
    defaultLocale,
    locales,
    space,
  })

  // Build foreign reference map before starting to insert any nodes
  const foreignReferenceMap = normalize.buildForeignReferenceMap({
    contentTypeItems,
    entryList,
    resolvable,
    defaultLocale,
    locales,
    space,
    useNameForId: pluginConfig.get(`useNameForId`),
  })

  const newOrUpdatedEntries = []
  entryList.forEach(entries => {
    entries.forEach(entry => {
      newOrUpdatedEntries.push(entry.sys.id)
    })
  })

  // Update existing entry nodes that weren't updated but that need reverse
  // links added.
  existingNodes
    .filter(n => _.includes(newOrUpdatedEntries, n.id))
    .forEach(n => {
      if (foreignReferenceMap[n.id]) {
        foreignReferenceMap[n.id].forEach(foreignReference => {
          // Add reverse links
          if (n[foreignReference.name]) {
            n[foreignReference.name].push(foreignReference.id)
            // It might already be there so we'll uniquify after pushing.
            n[foreignReference.name] = _.uniq(n[foreignReference.name])
          } else {
            // If is one foreign reference, there can always be many.
            // Best to be safe and put it in an array to start with.
            n[foreignReference.name] = [foreignReference.id]
          }
        })
      }
    })

  for (let i = 0; i < contentTypeItems.length; i++) {
    const contentTypeItem = contentTypeItems[i]

    // A contentType can hold lots of entries which create nodes
    // We wait until all nodes are created and processed until we handle the next one
    // TODO add batching in gatsby-core
    await Promise.all(
      normalize.createNodesForContentType({
        contentTypeItem,
        contentTypeItems,
        restrictedNodeFields,
        conflictFieldPrefix,
        entries: entryList[i],
        createNode,
        createNodeId,
        resolvable,
        foreignReferenceMap,
        defaultLocale,
        locales,
        space,
        useNameForId: pluginConfig.get(`useNameForId`),
        richTextOptions: pluginConfig.get(`richText`),
      })
    )
  }

  for (let i = 0; i < assets.length; i++) {
    // We wait for each asset to be process until handling the next one.
    await Promise.all(
      normalize.createAssetNodes({
        assetItem: assets[i],
        createNode,
        createNodeId,
        defaultLocale,
        locales,
        space,
      })
    )
  }

  if (pluginConfig.get(`downloadLocal`)) {
    await downloadContentfulAssets({
      actions,
      createNodeId,
      store,
      cache,
      getCache,
      getNodes,
      reporter,
    })
  }

  return
}

// Check if there are any ContentfulAsset nodes and if gatsby-image is installed. If so,
// add fragments for ContentfulAsset and gatsby-image. The fragment will cause an error
// if there's not ContentfulAsset nodes and without gatsby-image, the fragment is useless.
exports.onPreExtractQueries = async ({ store, getNodesByType }) => {
  const program = store.getState().program

  const CACHE_DIR = path.resolve(
    `${program.directory}/.cache/contentful/assets/`
  )
  await fs.ensureDir(CACHE_DIR)
}

/**
 * @packageDocumentation
 * @module @taquito/wallet-connect-2
 */

import Client from '@walletconnect/sign-client';
import { SignClientTypes, SessionTypes, PairingTypes } from '@walletconnect/types';
import QRCodeModal from '@walletconnect/legacy-modal';
import {
  createOriginationOperation,
  createSetDelegateOperation,
  createTransferOperation,
  WalletDelegateParams,
  WalletOriginateParams,
  WalletProvider,
  WalletTransferParams,
} from '@taquito/taquito';
import { getSdkError } from '@walletconnect/utils';
import { NetworkType, PermissionScopeMethods, PermissionScopeParam, SigningType } from './types';
import {
  ActiveAccountUnspecified,
  ActiveNetworkUnspecified,
  ConnectionFailed,
  InvalidAccount,
  InvalidNetwork,
  InvalidNetworkOrAccount,
  InvalidReceivedSessionNamespace,
  InvalidSessionKey,
  MissingRequiredScope,
  NotConnected,
} from './errors';

export { SignClientTypes, PairingTypes };
export * from './errors';
export * from './types';

const TEZOS_PLACEHOLDER = 'tezos';

export class WalletConnect2 implements WalletProvider {
  public signClient: Client;
  private session: SessionTypes.Struct | undefined;
  private activeAccount: string | undefined;
  private activeNetwork: string | undefined;

  constructor(signClient: Client) {
    this.signClient = signClient;

    this.signClient.on('session_delete', ({ topic }) => {
      if (this.session?.topic === topic) {
        this.session = undefined;
      }
    });

    this.signClient.on('session_expire', ({ topic }) => {
      if (this.session?.topic === topic) {
        this.session = undefined;
      }
    });

    this.signClient.on('session_update', ({ params, topic }) => {
      if (this.session?.topic === topic) {
        this.session.namespaces = params.namespaces;
        // validate namespace here too?
      }
    });

    this.signClient.on('session_event', () => {
      // TODO Handle session events, such as "chainChanged", "accountsChanged", etc.
    });
  }

  /**
   * @description Initialize a WalletConnect2 provider
   * (Initialize a wallect connect 2 client with persisted storage and a network connection)
   *
   * @example
   * ```
   * await WalletConnect2.init({
   *  projectId: "YOUR_PROJECT_ID",
   *  metadata: {
   *    name: "YOUR_DAPP_NAME",
   *    description: "YOUR_DAPP_DESCRIPTION",
   *    icons: ["ICON_URL"],
   *    url: "DAPP_URL",
   *  },
   * });
   * ```
   */
  static async init(initParams: SignClientTypes.Options) {
    const client = await Client.init(initParams);
    return new WalletConnect2(client);
  }

  /**
   * @description Request permission for a new session and establish a connection.
   *
   * @param connectParams.permissionScope The networks, methods, and events that will be granted permission
   * @param connectParams.pairingTopic Option to connect to an existing active pairing. If pairingTopic is defined, a prompt will appear in the corresponding wallet to accept or decline the session proposal. If no pairingTopic, a QR code modal will open in the dapp, allowing to connect to a wallet.
   * @param connectParams.registryUrl Optional registry of wallet deep links to show in the Modal
   * @error ConnectionFailed is thrown if no connection can be established with a wallet
   */
  async requestPermissions(connectParams: {
    permissionScope: PermissionScopeParam;
    pairingTopic?: string;
    registryUrl?: string;
  }) {
    try {
      const { uri, approval } = await this.signClient.connect({
        requiredNamespaces: {
          [TEZOS_PLACEHOLDER]: {
            chains: connectParams.permissionScope.networks.map(
              (network) => `${TEZOS_PLACEHOLDER}:${network}`
            ),
            methods: connectParams.permissionScope.methods,
            events: connectParams.permissionScope.events ?? [],
          },
        },
        pairingTopic: connectParams.pairingTopic,
      });

      if (uri) {
        QRCodeModal.open(
          uri,
          () => {
            // noop
          },
          { registryUrl: connectParams.registryUrl }
        );
      }
      const session = await approval();
      this.validateReceivedNamespace(connectParams.permissionScope, session.namespaces);
      this.session = session;
      this.setDefaultAccountAndNetwork();
    } catch (error) {
      throw new ConnectionFailed(error);
    } finally {
      QRCodeModal.close();
    }
  }

  /**
   * @description Access all existing active pairings
   */
  getAvailablePairing() {
    return this.signClient.pairing.getAll({ active: true });
  }

  /**
   * @description Access all existing sessions
   * @return an array of strings which represent the session keys
   */
  getAllExistingSessionKeys() {
    return this.signClient.session.keys;
  }

  /**
   * @description Configure the Client with an existing session.
   * The session is immediately restored without a prompt on the wallet to accept/decline it.
   * @error InvalidSessionKey is thrown if the provided session key doesn't exist
   */
  configureWithExistingSessionKey(key: string) {
    const sessions = this.getAllExistingSessionKeys();
    if (!sessions.includes(key)) {
      throw new InvalidSessionKey(key);
    }
    this.session = this.signClient.session.get(key);
    this.setDefaultAccountAndNetwork();
  }

  async disconnect() {
    if (this.session) {
      await this.signClient.disconnect({
        topic: this.session.topic,
        reason: getSdkError('USER_DISCONNECTED'),
      });
      this.deleteAll();
    }
  }

  getPeerMetadata() {
    return this.getSession().peer.metadata;
  }

  /**
   * @description Once the session is establish, send Tezos operations to be approved, signed and inject by the wallet.
   * @error MissingRequiredScope is thrown if permission to send operation was not granted
   */
  async sendOperations(params: any[]) {
    const session = this.getSession();
    if (!this.getPermittedMethods().includes(PermissionScopeMethods.OPERATION_REQUEST)) {
      throw new MissingRequiredScope(PermissionScopeMethods.OPERATION_REQUEST);
    }
    const network = await this.getActiveNetwork();
    const account = await this.getPKH();
    this.validateNetworkAndAccount(network, account);
    const hash = await this.signClient.request<string>({
      topic: session.topic,
      chainId: `${TEZOS_PLACEHOLDER}:${network}`,
      request: {
        method: PermissionScopeMethods.OPERATION_REQUEST,
        params: {
          account,
          operations: params,
        },
      },
    });
    return hash;
  }

  /**
   * @description Once the session is establish, send payload to be approved and signed by the wallet.
   * @error MissingRequiredScope is thrown if permission to sign payload was not granted
   */
  async signPayload(params: {
    signingType?: SigningType;
    payload: string;
    sourceAddress?: string;
  }) {
    const session = this.getSession();
    if (!this.getPermittedMethods().includes(PermissionScopeMethods.SIGN)) {
      throw new MissingRequiredScope(PermissionScopeMethods.SIGN);
    }
    const network = await this.getActiveNetwork();
    const account = await this.getPKH();
    this.validateNetworkAndAccount(network, account);
    const signature = await this.signClient.request<string>({
      topic: session.topic,
      chainId: `${TEZOS_PLACEHOLDER}:${network}`,
      request: {
        method: PermissionScopeMethods.SIGN,
        params: {
          account: params.sourceAddress ?? account,
          expression: params.payload,
          signingType: params.signingType,
        },
      },
    });
    return signature;
  }

  /**
   * @description Return all connected accounts from the active session
   * @error NotConnected if no active session
   */
  getAccounts() {
    return this.getTezosNamespace().accounts.map((account) => account.split(':')[2]);
  }

  /**
   * @description Set the active account.
   * Must be called if there are multiple accounts in the session and every time the active account is switched
   * @param pkh public key hash of the selected account
   * @error InvalidAccount thrown if the pkh is not part of the active accounts in the session
   */
  setActiveAccount(pkh: string) {
    if (!this.getAccounts().includes(pkh)) {
      throw new InvalidAccount(pkh);
    }
    this.activeAccount = pkh;
  }

  /**
   * @description Access the public key hash of the active account
   * @error ActiveAccountUnspecified thorwn when there are multiple Tezos account in the session and none is set as the active one
   */
  async getPKH() {
    if (!this.activeAccount) {
      throw new ActiveAccountUnspecified();
    }
    return this.activeAccount;
  }

  /**
   * @description Return all networks from the namespace of the active session
   * @error NotConnected if no active session
   */
  getNetworks() {
    return this.getPermittedNetwork();
  }

  /**
   * @description Set the active network.
   * Must be called if there are multiple network in the session and every time the active network is switched
   * @param network selected network
   * @error InvalidNetwork thrown if the network is not part of the active networks in the session
   */
  setActiveNetwork(network: NetworkType) {
    if (!this.getNetworks().includes(network)) {
      throw new InvalidNetwork(network);
    }
    this.activeNetwork = network;
  }

  /**
   * @description Access the active network
   * @error ActiveNetworkUnspecified thorwn when there are multiple Tezos netwroks in the session and none is set as the active one
   */
  async getActiveNetwork() {
    if (!this.activeNetwork) {
      throw new ActiveNetworkUnspecified();
    }
    return this.activeNetwork;
  }

  private setDefaultAccountAndNetwork() {
    const activeAccount = this.getAccounts();
    if (activeAccount.length === 1) {
      this.activeAccount = activeAccount[0];
    }
    const activeNetwork = this.getNetworks();
    if (activeNetwork.length === 1) {
      this.activeNetwork = activeNetwork[0];
    }
  }

  private deleteAll() {
    this.session = undefined;
    this.activeAccount = undefined;
  }

  private getSession() {
    if (!this.session) {
      throw new NotConnected();
    }
    return this.session;
  }

  isActiveSession() {
    return this.session ? true : false;
  }

  ping() {
    this.signClient.ping({ topic: this.getSession().topic });
  }

  private validateReceivedNamespace(
    scope: PermissionScopeParam,
    receivedNamespaces: Record<string, SessionTypes.Namespace>
  ) {
    if (receivedNamespaces[TEZOS_PLACEHOLDER]) {
      this.validateMethods(scope.methods, receivedNamespaces[TEZOS_PLACEHOLDER].methods);
      //this.validateEvents(scope.events, receivedNamespaces['tezos'].events);
      this.validateAccounts(scope.networks, receivedNamespaces[TEZOS_PLACEHOLDER].accounts);
    } else {
      throw new InvalidReceivedSessionNamespace(
        'All namespaces must be approved',
        getSdkError('USER_REJECTED').code,
        'tezos'
      );
    }
  }

  private validateMethods(requiredMethods: string[], receivedMethods: string[]) {
    const missingMethods: string[] = [];
    requiredMethods.forEach((method) => {
      if (!receivedMethods.includes(method)) {
        missingMethods.push(method);
      }
    });
    if (missingMethods.length > 0) {
      throw new InvalidReceivedSessionNamespace(
        'All methods must be approved',
        getSdkError('USER_REJECTED_METHODS').code,
        missingMethods
      );
    }
  }

  private validateAccounts(requiredNetwork: string[], receivedAccounts: string[]) {
    if (receivedAccounts.length === 0) {
      throw new InvalidReceivedSessionNamespace(
        'Accounts must not be empty',
        getSdkError('USER_REJECTED_CHAINS').code
      );
    }
    const receivedChains: string[] = [];
    const invalidChains: string[] = [];
    const missingChains: string[] = [];
    const invalidChainsNamespace: string[] = [];

    receivedAccounts.forEach((chain) => {
      const accountId = chain.split(':');
      if (accountId.length !== 3) {
        invalidChains.push(chain);
      }
      if (accountId[0] !== TEZOS_PLACEHOLDER) {
        invalidChainsNamespace.push(chain);
      }
      const network = accountId[1];
      if (!receivedChains.includes(network)) {
        receivedChains.push(network);
      }
    });

    if (invalidChains.length > 0) {
      throw new InvalidReceivedSessionNamespace(
        'Accounts must be CAIP-10 compliant',
        getSdkError('USER_REJECTED_CHAINS').code,
        invalidChains
      );
    }

    if (invalidChainsNamespace.length > 0) {
      throw new InvalidReceivedSessionNamespace(
        'Accounts must be defined in matching namespace',
        getSdkError('UNSUPPORTED_ACCOUNTS').code,
        invalidChainsNamespace
      );
    }
    requiredNetwork.forEach((network) => {
      if (!receivedChains.includes(network)) {
        missingChains.push(network);
      }
    });
    if (missingChains.length > 0) {
      throw new InvalidReceivedSessionNamespace(
        'All chains must have at least one account',
        getSdkError('USER_REJECTED_CHAINS').code,
        missingChains
      );
    }
  }

  private getTezosNamespace(): {
    accounts: string[];
    methods: string[];
    events: string[];
  } {
    if (Object.prototype.hasOwnProperty.call(this.getSession().namespaces, TEZOS_PLACEHOLDER)) {
      return this.getSession().namespaces[TEZOS_PLACEHOLDER];
    } else {
      throw new Error('invalid session, tezos namespace not found');
    }
  }

  private getTezosRequiredNamespace(): {
    chains: string[];
    methods: string[];
    events: string[];
  } {
    if (
      Object.prototype.hasOwnProperty.call(this.getSession().requiredNamespaces, TEZOS_PLACEHOLDER)
    ) {
      return this.getSession().requiredNamespaces[TEZOS_PLACEHOLDER];
    } else {
      throw new Error('invalid session, tezos requiredNamespaces not found');
    }
  }

  private validateNetworkAndAccount(network: string, account: string) {
    if (!this.getTezosNamespace().accounts.includes(`${TEZOS_PLACEHOLDER}:${network}:${account}`)) {
      throw new InvalidNetworkOrAccount(network, account);
    }
  }

  private getPermittedMethods() {
    return this.getTezosRequiredNamespace().methods;
  }

  private getPermittedEvents() {
    return this.getTezosRequiredNamespace().events;
  }

  private getPermittedNetwork() {
    return this.getTezosRequiredNamespace().chains.map((chain) => chain.split(':')[1]);
  }

  private formatParameters(params: any) {
    if (params.fee) {
      params.fee = params.fee.toString();
    }
    if (params.storageLimit) {
      params.storageLimit = params.storageLimit.toString();
    }
    if (params.gasLimit) {
      params.gasLimit = params.gasLimit.toString();
    }
    return params;
  }

  private removeDefaultParams(
    params: WalletTransferParams | WalletOriginateParams | WalletDelegateParams,
    operatedParams: any
  ) {
    if (!params.fee) {
      delete operatedParams.fee;
    }
    if (!params.storageLimit) {
      delete operatedParams.storage_limit;
    }
    if (!params.gasLimit) {
      delete operatedParams.gas_limit;
    }
    return operatedParams;
  }

  async mapTransferParamsToWalletParams(params: () => Promise<WalletTransferParams>) {
    const walletParams: WalletTransferParams = await params();

    return this.removeDefaultParams(
      walletParams,
      await createTransferOperation(this.formatParameters(walletParams))
    );
  }

  async mapOriginateParamsToWalletParams(params: () => Promise<WalletOriginateParams>) {
    const walletParams: WalletOriginateParams = await params();
    return this.removeDefaultParams(
      walletParams,
      await createOriginationOperation(this.formatParameters(walletParams))
    );
  }

  async mapDelegateParamsToWalletParams(params: () => Promise<WalletDelegateParams>) {
    const walletParams: WalletDelegateParams = await params();

    return this.removeDefaultParams(
      walletParams,
      await createSetDelegateOperation(this.formatParameters(walletParams))
    );
  }
}
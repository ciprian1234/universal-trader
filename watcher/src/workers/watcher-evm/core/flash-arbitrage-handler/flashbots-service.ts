import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';
import { ethers } from 'ethers';
import type { Logger } from '@/utils';
import type { Blockchain } from '../blockchain';
import type { BlockManager } from '../block-manager';

export interface FlashbotsConfig {
  relayUrl: string; // 'https://relay.flashbots.net' for mainnet
  authSignerKey?: string; // Optional: for authenticated bundles
}

export type FlashbotsServiceInput = {
  logger: Logger;
  blockchain: Blockchain;
  blockManager: BlockManager;
  config: FlashbotsConfig;
};

export interface BundleOptions {
  targetBlock?: number; // Specific block to target (optional)
  maxBlockNumber?: number; // Max block to try including bundle
  minTimestamp?: number;
  maxTimestamp?: number;
}

export interface SimulationResult {
  success: boolean;
  error?: string;
  gasUsed?: number;
  profit?: bigint;
  bundleHash?: string;
}

export class FlashbotsService {
  private readonly logger: Logger;
  private flashbotsProvider: FlashbotsBundleProvider | null = null;
  private readonly blockchain: Blockchain;
  private readonly blockManager: BlockManager;
  private authSigner: ethers.Wallet;
  private config: FlashbotsConfig;

  constructor(input: FlashbotsServiceInput) {
    this.blockchain = input.blockchain;
    this.blockManager = input.blockManager;
    this.config = input.config;
    this.logger = input.logger;

    // Auth signer (can be different from tx signer for privacy)
    // This is just for authentication with Flashbots relay
    const authKey = input.config.authSignerKey || ethers.Wallet.createRandom().privateKey;
    this.authSigner = new ethers.Wallet(authKey);

    this.logger.info('✅ FlashbotsService initialized');
    this.logger.info(`   Relay: ${input.config.relayUrl}`);
    this.logger.info(`   Auth signer: ${this.authSigner.address}`);
  }

  /**
   * Initialize Flashbots provider
   */
  async initialize(): Promise<void> {
    try {
      this.flashbotsProvider = await FlashbotsBundleProvider.create(
        this.blockchain.getProvider(),
        this.authSigner,
        this.config.relayUrl,
        'mainnet', // or 'goerli', 'sepolia'
      );

      this.logger.info('✅ Connected to Flashbots relay');
    } catch (error: any) {
      this.logger.error('❌ Failed to initialize Flashbots provider:', error.message);
      throw error;
    }
  }

  /**
   * Simulate a bundle before sending
   */
  async simulateBundle(signedTransactions: string[], targetBlock: number): Promise<SimulationResult> {
    if (!this.flashbotsProvider) throw new Error('Flashbots provider not initialized');

    this.logger.info(`🔍 Simulating bundle for block ${targetBlock}...`);
    const simulation = await this.flashbotsProvider.simulate(signedTransactions, targetBlock);
    this.logger.info('📄 Simulation result:', { simulation });

    // Check simulation results
    if ('error' in simulation) throw new Error(`Simulation error: ${simulation.error.message}`);

    // Simulation succeeded
    const result = simulation.results[0]; // First (and only) transaction in bundle
    const gasUsed = result.gasUsed;

    this.logger.info('✅ Simulation succeeded');
    this.logger.info(`   Gas used: ${gasUsed}`);
    this.logger.info(`   Tx hash: ${result.txHash}`);

    return {
      success: true,
      gasUsed,
      bundleHash: simulation.bundleHash,
    };
  }

  /**
   * Submit bundle without waiting for inclusion (NON-BLOCKING)
   */
  async submitBundle(signedTransactions: string[], options: BundleOptions = {}) {
    if (!this.flashbotsProvider) throw new Error('Flashbots provider not initialized');

    const currentBlock = this.blockManager.getCurrentBlockNumber();
    const targetBlock = options.targetBlock || currentBlock + 1;

    this.logger.info(`📤 Submitting bundle to block ${targetBlock} (non-blocking)...`);
    const bundleSubmission = await this.flashbotsProvider.sendRawBundle(signedTransactions, targetBlock);
    this.logger.info(`📄 Bundle submitted:`, { bundleSubmission });

    if ('error' in bundleSubmission) throw new Error(`Bundle submission failed: ${bundleSubmission.error.message}`);
    return bundleSubmission; // DON'T wait for inclusion - return immediately
  }

  /**
   * Get Flashbots stats (optional)
   */
  async getUserStats(): Promise<any> {
    if (!this.flashbotsProvider) throw new Error('Flashbots provider not initialized');

    try {
      const stats = await this.flashbotsProvider.getUserStatsV2();
      this.logger.info('📊 Flashbots user stats:', { stats });
      return stats;
    } catch (error: any) {
      this.logger.error('❌ Failed to get user stats:', { error });
      return null;
    }
  }

  /**
   * Get bundle stats (for debugging)
   */
  async getBundleStats(bundleHash: string, targetBlock: number) {
    if (!this.flashbotsProvider) throw new Error('Flashbots provider not initialized');

    try {
      const stats = await this.flashbotsProvider.getBundleStatsV2(bundleHash, targetBlock); // TBD use getBundleV2 in future
      this.logger.info('📊 Flashbots bundle stats:', { stats });
      return stats;
    } catch (error: any) {
      this.logger.error('❌ Failed to get bundle stats:', { error });
      return null;
    }
  }
}
